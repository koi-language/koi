# Koi Syntax Tests

Comprehensive test suite for Koi language syntax, covering TypeScript/JavaScript features.

## Test Categories

### Syntax Tests (`syntax/`)

Complete coverage of TypeScript/JavaScript syntax:

1. **01-operators.koi** - Arithmetic, comparison, and logical operators
   - `+`, `-`, `*`, `/`, `%`
   - `==`, `!=`, `===`, `!==`, `>`, `>=`, `<`, `<=`
   - `&&`, `||`, `!`

2. **02-control-flow.koi** - Control flow statements
   - `if/else`
   - `while` loops
   - `for` loops (traditional, for-of, for-in)

3. **03-arrow-functions.koi** - Arrow function syntax
   - Single parameter: `x => x * 2`
   - Multiple parameters: `(a, b) => a + b`
   - Block body: `n => { return n * 2 }`
   - With array methods: `map`, `filter`

4. **04-template-literals.koi** - Template string syntax
   - Basic: `` `Hello, ${name}` ``
   - Multiple expressions
   - Nested object access
   - Multiline templates

5. **05-objects-arrays.koi** - Object and array syntax
   - Object literals
   - Array literals
   - Spread operator: `{ ...obj }`
   - Special keys: `$gte`, `$in`, etc.

6. **06-variables.koi** - Variable declarations
   - `const` declarations
   - `let` declarations
   - Multiple declarations

7. **07-async-await.koi** - Async/await syntax
   - `await send` expressions
   - `await registry.*` calls
   - Multiple await calls

## Running Tests

### Run all tests:

```bash
chmod +x tests/run-all-tests.js
node tests/run-all-tests.js
```

### Run individual test:

```bash
export KOI_RUNTIME_PATH=~/Git/M/src/runtime
koi run tests/syntax/01-operators.koi
```

## Test Structure

Each test file follows this pattern:

```koi
// Test: Description
// Detailed description of what is tested
package "test.category"

role Worker { can execute }

Agent TestAgent : Worker {
  on testFeature(args: Json) {
    // Test implementation
    return { result: "..." }
  }
}

run TestAgent.testFeature({})
```

## Adding New Tests

1. Create a new `.koi` file in `tests/syntax/`
2. Follow the naming convention: `##-feature-name.koi`
3. Include descriptive comments
4. Test one feature category per file
5. Run the test suite to verify

## Expected Output

Tests should compile successfully and execute without errors. The test runner will report:

- ✓ PASS - Test compiled and ran successfully
- ✗ FAIL - Test failed to compile or threw an error

## Coverage

Current coverage includes:

- ✅ Operators (arithmetic, comparison, logical)
- ✅ Control flow (if/else, loops)
- ✅ Functions (arrow functions)
- ✅ Template literals
- ✅ Objects and arrays (including spread)
- ✅ Variables and constants
- ✅ Async/await

Future additions:

- Destructuring
- Rest parameters
- Default parameters
- Classes (if applicable to Koi)
- More array/object methods
- Error handling (try/catch)
