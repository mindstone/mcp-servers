process.on('disconnect', () => {
  process.exit(42);
});

if (process.send) {
  process.send('ready');
}

setTimeout(() => {
  process.exit(0);
}, 60_000);
