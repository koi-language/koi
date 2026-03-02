# TypeScript & npm Imports

Learn how to use npm packages and TypeScript modules in your Koi code.

## Table of Contents

- [Overview](#overview)
- [Importing npm Packages](#importing-npm-packages)
- [Importing Local TypeScript Files](#importing-local-typescript-files)
- [Using Imported Modules](#using-imported-modules)
- [TypeScript Syntax Support](#typescript-syntax-support)
- [Examples](#examples)
- [Best Practices](#best-practices)

## Overview

Koi supports importing:
- **npm packages** (lodash, crypto-js, etc.)
- **Local TypeScript files** (.ts, .tsx)
- **Local JavaScript files** (.js, .jsx, .mjs)

All imports are automatically:
- **Transpiled** (TypeScript → JavaScript)
- **Cached** (for performance)
- **Made available** in your Koi agents

## Importing npm Packages

### Step 1: Install the Package

```bash
npm install lodash
npm install crypto-js
npm install axios
```

### Step 2: Import in Koi

```koi
package "my.app"

import "lodash"
import "crypto-js"

role Worker { can execute }
```

### Step 3: Use in Agents

Imported modules are available with underscored names:

```koi
Agent Example : Worker {
  on process(args: Json) {
    // lodash → lodash
    const chunks = lodash.chunk([1, 2, 3, 4, 5, 6], 2)

    // crypto-js → crypto_js
    const hash = crypto_js.SHA256("password").toString()

    return { chunks: chunks, hash: hash }
  }
}
```

**Naming Convention**: Hyphens become underscores:
- `crypto-js` → `crypto_js`
- `lodash` → `lodash`
- `date-fns` → `date_fns`

## Importing Local TypeScript Files

### Create TypeScript Module

`utils/math.ts`:

```typescript
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }
}

export const PI = 3.141592653589793;
```

### Import in Koi

```koi
package "my.app"

import "./utils/math.ts"

role Worker { can execute }

Agent MathAgent : Worker {
  on calculate(args: Json) {
    // Use functions
    const sum = utils_math.add(5, 3)
    const product = utils_math.multiply(4, 7)

    // Use class
    const calc = new utils_math.Calculator()
    const result = calc.add(10, 20)

    // Use constants
    const pi = utils_math.PI

    return { sum, product, result, pi }
  }
}
```

**Naming Convention**: Path becomes module name:
- `./utils/math.ts` → `utils_math`
- `./helpers/string.ts` → `helpers_string`
- `../shared/common.ts` → `shared_common`

### Relative Paths

```koi
// Same directory
import "./helper.ts"

// Subdirectory
import "./utils/math.ts"

// Parent directory
import "../shared/constants.ts"
```

## Using Imported Modules

### Accessing Functions

```koi
import "lodash"

Agent Example : Worker {
  on process(args: Json) {
    const chunks = lodash.chunk([1, 2, 3, 4], 2)
    const unique = lodash.uniq([1, 2, 2, 3, 3])
    return { chunks, unique }
  }
}
```

### Accessing Classes

```koi
import "./calculator.ts"

Agent Example : Worker {
  on test(args: Json) {
    const calc = new utils_calculator.Calculator()
    const result = calc.add(10, 20)
    return { result }
  }
}
```

### Method Chaining

Koi fully supports TypeScript method chaining:

```koi
import "crypto-js"

Agent SecurityAgent : Worker {
  on hashPassword(args: Json) {
    // Chain methods
    const hash = crypto_js.SHA256(args.password).toString()
    const hash512 = crypto_js.SHA512(args.password).toString()

    return { sha256: hash, sha512: hash512 }
  }
}
```

### Property Access

```koi
import "./constants.ts"

Agent Example : Worker {
  on test(args: Json) {
    const pi = utils_constants.PI
    const e = utils_constants.E

    return { pi, e }
  }
}
```

## TypeScript Syntax Support

Koi supports the full TypeScript syntax:

### Classes & Constructors

```typescript
// TypeScript
export class Calculator {
  private history: string[] = [];

  add(a: number, b: number): number {
    const result = a + b;
    this.history.push(`${a} + ${b} = ${result}`);
    return result;
  }

  getHistory(): string[] {
    return [...this.history];
  }
}
```

```koi
// Koi
import "./calculator.ts"

const calc = new utils_calculator.Calculator()
const result = calc.add(10, 20)
const history = calc.getHistory()
```

### Interfaces & Types

```typescript
// TypeScript
export interface User {
  name: string;
  age: number;
}

export type Result<T> = {
  success: boolean;
  data: T;
};

export function getUser(): User {
  return { name: "Alice", age: 30 };
}
```

```koi
// Koi
import "./types.ts"

const user = utils_types.getUser()
console.log(user.name, user.age)
```

### Enums

```typescript
// TypeScript
export enum Status {
  Pending = "PENDING",
  Approved = "APPROVED",
  Rejected = "REJECTED"
}
```

```koi
// Koi
import "./enums.ts"

const status = utils_enums.Status.Approved
console.log(status)  // "APPROVED"
```

### Generics

```typescript
// TypeScript
export function identity<T>(value: T): T {
  return value;
}

export class Box<T> {
  constructor(private value: T) {}

  getValue(): T {
    return this.value;
  }
}
```

```koi
// Koi
import "./generics.ts"

const num = utils_generics.identity(42)
const box = new utils_generics.Box("hello")
const value = box.getValue()
```

## Examples

### Example 1: Using Lodash

```koi
package "lodash.demo"

import "lodash"

role Worker { can execute }

Agent DataProcessor : Worker {
  on process(args: Json) {
    const data = args.data

    // Chunk array
    const chunks = lodash.chunk(data, 3)

    // Get unique values
    const unique = lodash.uniq(data)

    // Sort
    const sorted = lodash.sortBy(data)

    // Group by property
    const grouped = lodash.groupBy(args.users, "role")

    return {
      chunks: chunks,
      unique: unique,
      sorted: sorted,
      grouped: grouped
    }
  }
}

run DataProcessor.process({
  data: [1, 2, 2, 3, 4, 4, 5],
  users: [
    { name: "Alice", role: "admin" },
    { name: "Bob", role: "user" },
    { name: "Carol", role: "admin" }
  ]
})
```

### Example 2: Crypto Hashing

```koi
package "crypto.demo"

import "crypto-js"

role SecurityAgent { can hash, can verify }

Agent HashAgent : SecurityAgent {
  on hashPassword(args: Json) {
    const password = args.password

    // Generate multiple hashes using chaining
    const md5 = crypto_js.MD5(password).toString()
    const sha1 = crypto_js.SHA1(password).toString()
    const sha256 = crypto_js.SHA256(password).toString()
    const sha512 = crypto_js.SHA512(password).toString()

    return {
      password: password,
      hashes: {
        md5: md5,
        sha1: sha1,
        sha256: sha256,
        sha512: sha512
      }
    }
  }

  on verifyPassword(args: Json) {
    const password = args.password
    const expectedHash = args.hash

    const actualHash = crypto_js.SHA256(password).toString()

    return {
      valid: actualHash == expectedHash,
      hash: actualHash
    }
  }
}

run HashAgent.hashPassword({ password: "mysecret123" })
```

### Example 3: Local TypeScript Module

`utils/calculator.ts`:

```typescript
export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }

  multiply(a: number, b: number): number {
    return a * b;
  }

  divide(a: number, b: number): number {
    if (b === 0) {
      throw new Error('Division by zero');
    }
    return a / b;
  }
}

export function factorial(n: number): number {
  if (n < 0) {
    throw new Error('Factorial not defined for negative numbers');
  }
  if (n === 0 || n === 1) {
    return 1;
  }
  return n * factorial(n - 1);
}

export const PI = 3.141592653589793;
```

`calculator-demo.koi`:

```koi
package "calculator.demo"

import "./utils/calculator.ts"

role Worker { can execute }

Agent MathAgent : Worker {
  on calculate(args: Json) {
    // Use class
    const calc = new utils_calculator.Calculator()
    const sum = calc.add(10, 5)
    const diff = calc.subtract(10, 5)
    const product = calc.multiply(10, 5)
    const quotient = calc.divide(10, 5)

    // Use function
    const fact5 = utils_calculator.factorial(5)

    // Use constant
    const pi = utils_calculator.PI

    return {
      sum: sum,
      diff: diff,
      product: product,
      quotient: quotient,
      factorial5: fact5,
      pi: pi
    }
  }
}

run MathAgent.calculate({})
```

## Best Practices

### 1. Install Types for npm Packages

```bash
# Install package
npm install lodash

# Install TypeScript types
npm install --save-dev @types/lodash
```

This enables better IDE support.

### 2. Use Descriptive Module Names

```typescript
// ✅ Good
// utils/string-helpers.ts
export function capitalize(s: string): string { /* ... */ }

// ✅ Good
// services/api-client.ts
export class APIClient { /* ... */ }
```

### 3. Export What You Need

```typescript
// ✅ Good: Explicit exports
export function add(a: number, b: number): number { /* ... */ }
export function multiply(a: number, b: number): number { /* ... */ }

// ❌ Bad: Everything is global
function add(a, b) { /* ... */ }
function multiply(a, b) { /* ... */ }
```

### 4. Organize Imports

```koi
package "my.app"

// npm packages first
import "lodash"
import "crypto-js"
import "axios"

// local modules after
import "./utils/math.ts"
import "./services/api.ts"

role Worker { can execute }
```

### 5. Use TypeScript for Reusable Code

```typescript
// ✅ Good: Reusable TypeScript module
// utils/validators.ts
export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export function isURL(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}
```

```koi
// Use in multiple agents
import "./utils/validators.ts"

Agent EmailAgent : Worker {
  on validate(args: Json) {
    return { valid: utils_validators.isEmail(args.email) }
  }
}

Agent URLAgent : Worker {
  on validate(args: Json) {
    return { valid: utils_validators.isURL(args.url) }
  }
}
```

## Automatic Transpilation

Koi automatically transpiles TypeScript files:

```
1. Import detected
   "./utils/math.ts"

2. Check for .js file
   "./utils/math.js"

3. If missing or outdated:
   Transpile .ts → .js

4. Cache .js file
   (reuse on next run)

5. Import .js in generated code
```

### Caching

Transpiled files are cached:

```
utils/
├── math.ts         (source)
└── math.js         (cached)
```

The cache is invalidated when the `.ts` file changes.

## Troubleshooting

### "Cannot find module"

**Solution**: Check the path is correct:

```koi
// ✅ Correct
import "./utils/math.ts"

// ❌ Wrong (missing ./)
import "utils/math.ts"
```

### "Module not found: lodash"

**Solution**: Install the package:

```bash
npm install lodash
```

### TypeScript compilation errors

**Solution**: Check your TypeScript syntax in the `.ts` file:

```bash
npx tsc utils/math.ts --noEmit
```

### "Cannot access property of undefined"

**Solution**: Check the module is properly imported and the export name matches:

```typescript
// math.ts
export function add(a, b) { return a + b; }  // ✅ exported
function multiply(a, b) { return a * b; }    // ❌ not exported
```

```koi
const sum = utils_math.add(1, 2)        // ✅ works
const product = utils_math.multiply(1, 2)  // ❌ undefined
```

## What's Next?

- **[Testing Guide](12-testing.md)** - Unit test your TypeScript modules with Jest
- **[Advanced Topics](15-advanced.md)** - Source maps, debugging, performance

---

**Next**: [Testing Guide](12-testing.md) →
