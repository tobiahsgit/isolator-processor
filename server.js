import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json({ limit: '2mb' }));

function auth(req,res,next){
  const header = req.get('authorization') || '';
  const token  = header.replace(/^Bearer\s+/i,'').trim();
  const secret = process.env.PROCESSOR_TOKEN || '';
  if (!token || !secret) return res.status(401).json({ error: 'unauthorized' });
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return res.status(401).json({ error: 'unauthorized' });
  try {
    if (!crypto.timingSafeEqual(a,b)) return res.status(401).json({ error: 'unauthorized' });
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/health', (_req,res)=>res.json({ ok:true }));

// intake-only for now: verify auth, validate payload, ack
app.post('/', auth, async (req,res)=>{
  const { mode, url, title } = req.body || {};
  if (!mode || !url) return res.status(400).json({ error:'missing mode/url' });
  return res.json({ ok:true, intake:true, mode, url, title: title || null });
});

const port = process.env.PORT || 10000;
app.listen(port, ()=>console.log('processor up on', port));
