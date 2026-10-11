// Acceptance must assert the requested round, including a completed connection.
export function expectedPairingResult(connection: string, pairing: string, expected: 'paired' | 'denied' | 'revoked'): 'passed' | 'failed' {
  const state = expected === 'paired' ? 'ready' : expected === 'denied' ? 'unpaired' : 'revoked';
  return connection === state && pairing === expected ? 'passed' : 'failed';
}
