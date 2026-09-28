import { createServer } from 'node:http';
/** Loopback-only deterministic provider. No credentials and no external calls. */
export async function providerFixture(options = {}) {
  const requests = [];
  const sockets = new Set();
  let delay = options.delayMs ?? 0;
  // Optional scripted responses: each item is consumed per request in order.
  // { text } -> plain content; { toolCall: { name, arguments } } -> an
  // openai-completions tool_calls finish, so the real pi agent loop dispatches
  // the call to the registered tool and posts the result back (next request).
  const script = options.script ? [...options.script] : [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404);
      res.end();
      return;
    }
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 1048576) {
        res.writeHead(413);
        res.end();
        return;
      }
    }
    const body = JSON.parse(text);
    requests.push(body);
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const base = {
        id: 'relay-fixture',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'fixture',
      };
      const step = script.length ? script.shift() : { text: 'Fixture received the event.' };
      if (step.toolCall) {
        const call = {
          index: 0,
          id: 'call-fixture-' + requests.length,
          type: 'function',
          function: {
            name: step.toolCall.name,
            arguments: JSON.stringify(step.toolCall.arguments ?? {}),
          },
        };
        res.write(
          'data: ' +
            JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null }],
            }) +
            '\n\n',
        );
        res.write(
          'data: ' +
            JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }) +
            '\n\n',
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      res.write(
        'data: ' +
          JSON.stringify({
            ...base,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: step.text ?? 'Fixture received the event.' },
                finish_reason: null,
              },
            ],
          }) +
          '\n\n',
      );
      res.write(
        'data: ' +
          JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }) +
          '\n\n',
      );
      res.end('data: [DONE]\n\n');
    };
    if (delay) setTimeout(send, delay);
    else send();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    setDelay(ms) {
      delay = ms;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
