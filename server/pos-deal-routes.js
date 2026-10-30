import express from 'express';
import '@shopify/shopify-api/adapters/node';
import {shopifyApi, LogSeverity} from '@shopify/shopify-api';
import {createDealService} from './deal-service.js';
import {BundleError, requireValue} from './bundle-errors.js';
import {quoteCart, SHOP} from '../shared/pos-deal.js';

const origins = new Set(['https://cdn.shopify.com', 'https://extensions.shopifycdn.com']);
export function createPosVerifier({apiKey, apiSecretKey, shop, origin}) {
  if (!apiKey || !apiSecretKey || shop !== SHOP) return null;
  const sdk = shopifyApi({apiKey, apiSecretKey, hostName:new URL(origin).host,
    apiVersion:'2026-10', isEmbeddedApp:true, logger:{level:LogSeverity.Error, log:() => {}}});
  return async token => {
    const p = await sdk.session.decodeSessionToken(token);
    const now = Math.floor(Date.now() / 1000);
    requireValue(p.dest === `https://${shop}` && p.iss === `https://${shop}/admin` &&
      typeof p.sub === 'string' && /^\d+$/.test(p.sub) &&
      Number.isSafeInteger(p.exp) && p.exp > now && Number.isSafeInteger(p.nbf) && p.nbf <= now + 10 &&
      Number.isSafeInteger(p.iat) && p.iat <= now + 10 && p.exp - p.iat <= 3600,
      'Open Head Happy deals from Shopify POS again.', 401);
    return {userId:p.sub};
  };
}

export function createPosDealRouter({store, catalog, verify}) {
  const router = express.Router(), deals = createDealService({store,catalog});
  router.use((req,res,next) => {
    res.set('Cache-Control','no-store'); res.vary('Origin');
    if (req.headers.origin && !origins.has(req.headers.origin)) return res.status(403).json({error:'This endpoint is for Shopify POS.'});
    if (req.headers.origin) res.set('Access-Control-Allow-Origin',req.headers.origin);
    res.set('Access-Control-Allow-Headers','Authorization, Content-Type');
    res.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  router.use(async (req,res,next) => {
    if (!verify) return res.status(503).json({error:'The till connection is not configured yet. Ask the manager to finish setup.'});
    const token = /^Bearer ([A-Za-z0-9_.-]{20,8192})$/.exec(req.headers.authorization || '')?.[1];
    if (!token) return res.status(401).json({error:'Open Head Happy deals from Shopify POS.'});
    try { req.pos = await verify(token); next(); }
    catch { res.status(401).json({error:'Your POS session could not be verified. Close and reopen Head Happy deals.'}); }
  });
  // Bound concurrent catalogue work per signed-in user. Tokens and errors are never logged.
  const active = new Set();
  router.use((req,res,next) => {
    if (active.has(req.pos.userId) || active.size >= 20) return res.status(429).json({error:'A deal check is already running. Wait a moment and try again.'});
    active.add(req.pos.userId);
    const release = () => active.delete(req.pos.userId);
    res.once('finish',release); res.once('close',release); next();
  });
  router.use(express.json({limit:'100kb'}));
  const wrap = fn => (req,res,next) => Promise.resolve(fn(req,res)).catch(next);
  router.get('/',wrap(async (_req,res) => {
    res.json({deals:(await store.listRecipes()).map(({id,version,name}) => ({id,version,name}))});
  }));
  router.post('/definition',wrap(async (req,res) => {
    const {id,version,session} = req.body || {};
    requireValue(session?.shopDomain === SHOP && Number.isSafeInteger(session.locationId) && session.locationId > 0,'A Head Happy POS location is required.');
    const deal = await deals.definition(id,`gid://shopify/Location/${session.locationId}`,version);
    // POS staff need choice labels and stock, never unit costs or staff history.
    res.json({...deal,groups:deal.groups.map(group => ({...group,items:group.items.map(v => ({
      id:v.id,productId:v.productId,sku:v.sku,barcode:v.barcode,title:v.title,productTitle:v.productTitle,
      price:v.price,available:v.available,tracked:v.tracked,status:v.status,requiresComponents:v.requiresComponents,
    }))}))});
  }));
  router.post('/quote',wrap(async (req,res) => {
    const {id,version,session,cart,selections,sets} = req.body || {};
    requireValue(session?.shopDomain === SHOP && Number.isSafeInteger(session.locationId) && session.locationId > 0,'A Head Happy POS location is required.');
    const metadata = await catalog.metadata();
    requireValue(metadata.taxesIncluded === true,'This deal needs tax-inclusive Shopify prices. Ask a manager to check the store settings.',422);
    const deal = await deals.definition(id,`gid://shopify/Location/${session.locationId}`,version);
    let quote;
    try { quote = quoteCart(deal,cart,session,selections,sets); }
    catch (error) { throw new BundleError(error.message,422); }
    res.json({...quote, expiresAt:Date.now()+30000});
  }));
  router.use((error,_req,res,_next) => res.status(error instanceof BundleError ? error.status : error.type === 'entity.too.large' ? 413 : 503)
    .json({error:error instanceof BundleError ? error.message : 'Could not check the saved deal. Try again before taking payment.'}));
  return router;
}
