/**
 * openapi.ts — validates docs/openapi.json and prints its path list.
 *
 * The spec is HAND-WRITTEN (docs/openapi.json), not generated from
 * decorators: Agent A had not added Swagger decorators when it was
 * written, and generating from decorators was explicitly out of scope.
 * Run: `npm run openapi`.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const specPath = join(__dirname, '..', 'docs', 'openapi.json');

function main(): void {
  const raw = readFileSync(specPath, 'utf8');
  const spec = JSON.parse(raw);
  if (spec.openapi !== '3.0.0' && !String(spec.openapi ?? '').startsWith('3.0')) {
    throw new Error(`docs/openapi.json: unexpected openapi version ${spec.openapi}`);
  }
  const paths = Object.keys(spec.paths ?? {});
  if (paths.length === 0) throw new Error('docs/openapi.json: no paths defined');
  // eslint-disable-next-line no-console
  console.log(`docs/openapi.json OK — OpenAPI ${spec.openapi}, ${paths.length} paths:`);
  for (const p of paths.sort()) {
    const methods = Object.keys(spec.paths[p]).join(', ').toUpperCase();
    // eslint-disable-next-line no-console
    console.log(`  ${p}  [${methods}]`);
  }
}

main();
