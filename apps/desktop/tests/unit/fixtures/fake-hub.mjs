// A stand-in for the embedded hub: reports a port like hub.mjs does, or fails, as asked.
const mode = process.env.FAKE_HUB_MODE ?? 'ok';
console.log(`fake hub starting in ${process.env.DATA_DIR} with PATH ${process.env.PATH}`);
if (mode === 'crash') {
  console.error('boom: cannot open the database');
  process.exit(3);
}
const port = Number(process.env.COREHUB_DESKTOP_PORT) || 45678;
if (mode === 'ok' || mode === 'stubborn' || mode === 'relay')
  process.send({ type: 'listening', port });
if (mode === 'stubborn') process.on('SIGTERM', () => console.log('ignoring SIGTERM'));
if (mode === 'relay') {
  // Asks the app about the way in from outside, as hub/entry.ts does, and says what it heard.
  process.on('message', (message) => {
    if (message?.type === 'relay-answer')
      console.log(`relay answer ${message.id} connected=${message.state?.connected}`);
    if (message?.type === 'relay-state') console.log(`relay state url=${message.state?.relay_url}`);
  });
  process.send({ type: 'relay', id: 7, op: 'get' });
}
setInterval(() => {}, 1000);
