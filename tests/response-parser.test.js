// node tests/response-parser.test.js
// A plain YAML value holding ": " must not throw away the whole action (opfh, 23/11/2026: a 50-item `proponer`
// batch was rejected again and again for one `motivo: Nombre en mayúsculas: se escribe …` line).
import assert from 'node:assert/strict';
import { parseReactiveResponse } from '../src/runtime/llm/response-parser.js';

const response = `actionType: direct
intent: call_mcp
mcp: opfh
tool: proponer
input:
  propuestas:
    - tipo: nombre
      escrito: FINCA TOLI FRUTAS, S.L.
      motivo: Nombre en mayúsculas: se escribe «Finca Toli Frutas, S.L.».
    - tipo: nombre
      motivo: "ya citado: ok"
      nota: |
        linea con: dos puntos
        otra`;

const action = await parseReactiveResponse(response);
const [a, b] = action.input.propuestas;
assert.equal(a.motivo, 'Nombre en mayúsculas: se escribe «Finca Toli Frutas, S.L.».');
assert.equal(a.escrito, 'FINCA TOLI FRUTAS, S.L.');
assert.equal(b.motivo, 'ya citado: ok');
assert.equal(b.nota, 'linea con: dos puntos\notra\n');
console.log('response-parser: ok');
