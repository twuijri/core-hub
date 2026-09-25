// A stand-in for the embedded hub: reports a port like hub.mjs does, or fails, as asked.
const mode = process.env.FAKE_HUB_MODE ?? 'ok';
console.log(`fake hub starting in ${process.env.DATA_DIR} with PATH ${process.env.PATH}`);
if (mode === 'crash') {
  console.error('boom: cannot open the database');
  process.exit(3);
}
if (mode === 'ok' || mode === 'stubborn') process.send({ type: 'listening', port: 45678 });
if (mode === 'stubborn') process.on('SIGTERM', () => console.log('ignoring SIGTERM'));
setInterval(() => {}, 1000);
