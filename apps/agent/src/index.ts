export function startAgent() {
  console.log('Slice Agent initialized');
}

if (process.env.NODE_ENV !== 'test') {
  startAgent();
}
