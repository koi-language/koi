# Testing Guide

Learn how to test your Koi code using Jest and other testing frameworks.

## Table of Contents

- [Overview](#overview)
- [Setup Jest](#setup-jest)
- [Testing TypeScript Modules](#testing-typescript-modules)
- [Testing Agents](#testing-agents)
- [Running Tests](#running-tests)
- [Best Practices](#best-practices)

## Overview

Koi supports unit testing through:
- **Jest** - JavaScript testing framework
- **TypeScript** - Test TypeScript modules directly
- **Agent testing** - Test agent handlers and behavior

## Setup Jest

### Step 1: Install Jest

```bash
npm install --save-dev jest @types/jest ts-jest
```

### Step 2: Configure Jest

Create `jest.config.cjs`:

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        target: 'ES2020',
        module: 'commonjs',
        esModuleInterop: true,
        skipLibCheck: true,
        strict: false
      }
    }]
  }
};
```

### Step 3: Add Test Script

In `package.json`:

```json
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage"
  }
}
```

## Testing TypeScript Modules

### Create Module

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
    throw new Error('Factorial is not defined for negative numbers');
  }
  if (n === 0 || n === 1) {
    return 1;
  }
  return n * factorial(n - 1);
}

export function isPrime(n: number): boolean {
  if (n <= 1) return false;
  if (n <= 3) return true;
  if (n % 2 === 0 || n % 3 === 0) return false;

  for (let i = 5; i * i <= n; i += 6) {
    if (n % i === 0 || n % (i + 2) === 0) {
      return false;
    }
  }

  return true;
}
```

### Create Test

`utils/calculator.test.ts`:

```typescript
import { Calculator, factorial, isPrime } from './calculator';

describe('Calculator', () => {
  let calc: Calculator;

  beforeEach(() => {
    calc = new Calculator();
  });

  describe('add', () => {
    test('should add two positive numbers', () => {
      expect(calc.add(2, 3)).toBe(5);
    });

    test('should add negative numbers', () => {
      expect(calc.add(-5, -3)).toBe(-8);
    });

    test('should add zero', () => {
      expect(calc.add(5, 0)).toBe(5);
    });
  });

  describe('subtract', () => {
    test('should subtract two numbers', () => {
      expect(calc.subtract(10, 4)).toBe(6);
    });

    test('should handle negative results', () => {
      expect(calc.subtract(5, 10)).toBe(-5);
    });
  });

  describe('multiply', () => {
    test('should multiply two numbers', () => {
      expect(calc.multiply(4, 5)).toBe(20);
    });

    test('should return zero when multiplying by zero', () => {
      expect(calc.multiply(100, 0)).toBe(0);
    });
  });

  describe('divide', () => {
    test('should divide two numbers', () => {
      expect(calc.divide(10, 2)).toBe(5);
    });

    test('should throw error on division by zero', () => {
      expect(() => calc.divide(10, 0)).toThrow('Division by zero');
    });
  });
});

describe('factorial', () => {
  test('should calculate factorial of 0', () => {
    expect(factorial(0)).toBe(1);
  });

  test('should calculate factorial of 5', () => {
    expect(factorial(5)).toBe(120);
  });

  test('should throw error for negative numbers', () => {
    expect(() => factorial(-1)).toThrow('Factorial is not defined for negative numbers');
  });
});

describe('isPrime', () => {
  test('should return false for numbers less than 2', () => {
    expect(isPrime(0)).toBe(false);
    expect(isPrime(1)).toBe(false);
  });

  test('should return true for prime numbers', () => {
    expect(isPrime(2)).toBe(true);
    expect(isPrime(7)).toBe(true);
    expect(isPrime(17)).toBe(true);
  });

  test('should return false for composite numbers', () => {
    expect(isPrime(4)).toBe(false);
    expect(isPrime(9)).toBe(false);
  });
});
```

### Run Tests

```bash
npm test
```

Output:

```
PASS  utils/calculator.test.ts
  Calculator
    add
      ✓ should add two positive numbers (2 ms)
      ✓ should add negative numbers
      ✓ should add zero
    subtract
      ✓ should subtract two numbers
      ✓ should handle negative results
    multiply
      ✓ should multiply two numbers
      ✓ should return zero when multiplying by zero
    divide
      ✓ should divide two numbers
      ✓ should throw error on division by zero (5 ms)
  factorial
    ✓ should calculate factorial of 0
    ✓ should calculate factorial of 5
    ✓ should throw error for negative numbers
  isPrime
    ✓ should return false for numbers less than 2
    ✓ should return true for prime numbers
    ✓ should return false for composite numbers

Test Suites: 1 passed, 1 total
Tests:       15 passed, 15 total
```

## Testing Agents

### Create Agent

`agents/validator.koi`:

```koi
package "test.agents"

role Worker { can execute }

Agent Validator : Worker {
  on validateEmail(args: Json) {
    const email = args.email
    const valid = email != null && email.includes("@")

    return {
      valid: valid,
      email: email
    }
  }

  on validateAge(args: Json) {
    const age = args.age
    const valid = age != null && age >= 0 && age <= 120

    return {
      valid: valid,
      age: age
    }
  }
}
```

### Compile & Test

```bash
# Compile to JavaScript
koi compile agents/validator.koi

# Create test file
```

`agents/validator.test.ts`:

```typescript
// Import the compiled agent
import { Validator } from '../.build/validator.js';

describe('Validator Agent', () => {
  describe('validateEmail', () => {
    test('should validate correct email', async () => {
      const result = await Validator.handle('validateEmail', {
        email: 'user@example.com'
      });

      expect(result.valid).toBe(true);
      expect(result.email).toBe('user@example.com');
    });

    test('should reject invalid email', async () => {
      const result = await Validator.handle('validateEmail', {
        email: 'notanemail'
      });

      expect(result.valid).toBe(false);
    });

    test('should reject null email', async () => {
      const result = await Validator.handle('validateEmail', {
        email: null
      });

      expect(result.valid).toBe(false);
    });
  });

  describe('validateAge', () => {
    test('should validate correct age', async () => {
      const result = await Validator.handle('validateAge', {
        age: 25
      });

      expect(result.valid).toBe(true);
      expect(result.age).toBe(25);
    });

    test('should reject negative age', async () => {
      const result = await Validator.handle('validateAge', {
        age: -5
      });

      expect(result.valid).toBe(false);
    });

    test('should reject age over 120', async () => {
      const result = await Validator.handle('validateAge', {
        age: 150
      });

      expect(result.valid).toBe(false);
    });
  });
});
```

## Running Tests

### Run All Tests

```bash
npm test
```

### Run Specific Test

```bash
npm test calculator.test.ts
```

### Watch Mode

```bash
npm run test:watch
```

Tests re-run automatically when files change.

### Coverage Report

```bash
npm run test:coverage
```

Output:

```
------------------------|---------|----------|---------|---------|
File                    | % Stmts | % Branch | % Funcs | % Lines |
------------------------|---------|----------|---------|---------|
All files               |   95.23 |    90.00 |  100.00 |   95.00 |
 calculator.ts          |   95.23 |    90.00 |  100.00 |   95.00 |
------------------------|---------|----------|---------|---------|
```

## Best Practices

### 1. Test Edge Cases

```typescript
describe('divide', () => {
  test('should divide positive numbers', () => {
    expect(calc.divide(10, 2)).toBe(5);
  });

  test('should divide negative numbers', () => {
    expect(calc.divide(-10, 2)).toBe(-5);
  });

  test('should handle decimal results', () => {
    expect(calc.divide(7, 2)).toBe(3.5);
  });

  test('should throw on division by zero', () => {
    expect(() => calc.divide(10, 0)).toThrow();
  });

  test('should handle zero dividend', () => {
    expect(calc.divide(0, 5)).toBe(0);
  });
});
```

### 2. Use Descriptive Test Names

```typescript
// ✅ Good: Clear what's being tested
test('should return true for prime numbers', () => { /* ... */ });
test('should throw error on division by zero', () => { /* ... */ });

// ❌ Bad: Unclear
test('test1', () => { /* ... */ });
test('works', () => { /* ... */ });
```

### 3. Organize with describe()

```typescript
describe('Calculator', () => {
  describe('add', () => {
    test('...', () => {});
    test('...', () => {});
  });

  describe('subtract', () => {
    test('...', () => {});
    test('...', () => {});
  });
});
```

### 4. Use beforeEach for Setup

```typescript
describe('Calculator', () => {
  let calc: Calculator;

  beforeEach(() => {
    calc = new Calculator();
  });

  test('should add', () => {
    expect(calc.add(2, 3)).toBe(5);
  });
});
```

### 5. Test Error Conditions

```typescript
test('should throw error for negative input', () => {
  expect(() => factorial(-1)).toThrow('Factorial is not defined for negative numbers');
});
```

## Example: Testing npm Package Integration

Test code that uses imported npm packages:

`services/hash-service.ts`:

```typescript
import CryptoJS from 'crypto-js';

export class HashService {
  hashPassword(password: string): string {
    return CryptoJS.SHA256(password).toString();
  }

  verifyPassword(password: string, hash: string): boolean {
    const computedHash = this.hashPassword(password);
    return computedHash === hash;
  }
}
```

`services/hash-service.test.ts`:

```typescript
import { HashService } from './hash-service';

describe('HashService', () => {
  let service: HashService;

  beforeEach(() => {
    service = new HashService();
  });

  describe('hashPassword', () => {
    test('should generate SHA256 hash', () => {
      const hash = service.hashPassword('password123');
      expect(hash).toBeTruthy();
      expect(hash.length).toBe(64); // SHA256 produces 64 hex characters
    });

    test('should generate consistent hashes', () => {
      const hash1 = service.hashPassword('test');
      const hash2 = service.hashPassword('test');
      expect(hash1).toBe(hash2);
    });

    test('should generate different hashes for different inputs', () => {
      const hash1 = service.hashPassword('password1');
      const hash2 = service.hashPassword('password2');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyPassword', () => {
    test('should verify correct password', () => {
      const password = 'mysecret';
      const hash = service.hashPassword(password);
      expect(service.verifyPassword(password, hash)).toBe(true);
    });

    test('should reject incorrect password', () => {
      const hash = service.hashPassword('correct');
      expect(service.verifyPassword('wrong', hash)).toBe(false);
    });
  });
});
```

## Troubleshooting

### "Cannot find module"

**Solution**: Ensure module is compiled:

```bash
koi compile agents/validator.koi
```

### "ReferenceError: module is not defined"

**Solution**: Use `.cjs` extension for Jest config (for ES modules project):

```bash
mv jest.config.js jest.config.cjs
```

### TypeScript errors in tests

**Solution**: Install type definitions:

```bash
npm install --save-dev @types/jest @types/node
```

## What's Next?

- **[Complete Examples](14-examples.md)** - See full working examples
- **[Advanced Topics](15-advanced.md)** - Debugging, performance, source maps

---

**Next**: [Complete Examples](14-examples.md) →
