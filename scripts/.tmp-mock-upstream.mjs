#!/usr/bin/env node
// Local mock upstream for wrangler dev streaming reproduction.
// Serves OpenAI-style SSE with realistic timing (chunks spread over time).
import http from 'node:http';

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    let i = 0;
    const timer = setInterval(() => {
      i++;
      if (i <= 10) {
        send({ id: 'chatcmpl-mock', choices: [{ index: 0, delta: { content: `第${i}个字` }, finish_reason: null }] });
      } else if (i === 11) {
        send({ id: 'chatcmpl-mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      } else {
        res.write('data: [DONE]\n\n');
        clearInterval(timer);
        res.end();
      }
    }, 40);
    req.on('close', () => clearInterval(timer));
  });
});

server.listen(9999, '127.0.0.1', () => console.log('mock upstream on http://127.0.0.1:9999'));
