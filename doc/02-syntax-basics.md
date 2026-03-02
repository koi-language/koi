# Syntax Basics

This guide covers Koi's syntax for variables, types, expressions, and control flow.

## Table of Contents

- [Package Declaration](#package-declaration)
- [Variables](#variables)
- [Types](#types)
- [Expressions](#expressions)
- [Control Flow](#control-flow)
- [Functions](#functions)
- [Comments](#comments)
- [Imports](#imports)

## Package Declaration

Every Koi file starts with a package declaration:

```koi
package "com.example.myapp"
```

Use reverse domain notation or any unique identifier.

## Variables

### Declaring Variables

```koi
const x = 10
const name = "Alice"
const isValid = true
const data = { key: "value" }
const numbers = [1, 2, 3]
```

Koi uses `const` for all variables. Variables are immutable by reference but objects/arrays are mutable:

```koi
const user = { name: "Alice", age: 30 }
user.age = 31  // ✅ Allowed (mutating object)

const x = 10
x = 20  // ❌ Error (reassigning const)
```

### Variable Scope

Variables follow JavaScript scoping rules:

```koi
Agent Example : Worker {
  on test(args: Json) {
    const outer = "outside"

    if (true) {
      const inner = "inside"
      console.log(outer)  // ✅ Can access outer
    }

    console.log(inner)  // ❌ Error: inner not defined
  }
}
```

## Types

Koi uses TypeScript-style type annotations:

### Basic Types

```koi
const str: string = "hello"
const num: number = 42
const bool: boolean = true
const obj: Json = { key: "value" }
const arr: array = [1, 2, 3]
```

### Json Type

`Json` is the primary type for data:

```koi
Agent DataHandler : Worker {
  on process(args: Json) {
    const name = args.name
    const age = args.age
    return { result: "processed" }
  }
}
```

### Function Types

Handler signatures use types:

```koi
on handlerName(args: Json): Json {
  return { result: "value" }
}
```

## Expressions

### Arithmetic

```koi
const sum = 10 + 5       // 15
const diff = 10 - 5      // 5
const product = 10 * 5   // 50
const quotient = 10 / 5  // 2
const remainder = 10 % 3 // 1
const power = 2 ** 3     // 8
```

### String Operations

```koi
const greeting = "Hello" + " " + "World"  // "Hello World"
const name = "Alice"
const message = "Hello, " + name + "!"    // "Hello, Alice!"
```

### String Templates

```koi
const name = "Alice"
const age = 30
const message = `Hello, ${name}! You are ${age} years old.`
```

### Comparison

```koi
const eq = 10 == 10          // true
const neq = 10 != 5          // true
const lt = 5 < 10            // true
const lte = 10 <= 10         // true
const gt = 10 > 5            // true
const gte = 10 >= 10         // true
```

### Logical Operations

```koi
const and = true && false    // false
const or = true || false     // true
const not = !true            // false
```

### Member Access

```koi
const obj = { name: "Alice", age: 30 }
const name = obj.name        // "Alice"
const age = obj["age"]       // 30

const arr = [1, 2, 3]
const first = arr[0]         // 1
```

### Method Chaining

Koi supports TypeScript-style chaining:

```koi
import "crypto-js"

const hash = crypto_js.SHA256("password").toString()
const upper = "hello".toUpperCase()
const length = [1, 2, 3].length
```

### new Operator

Create object instances:

```koi
import "./calculator.ts"

const calc = new utils_calculator.Calculator()
const result = calc.add(10, 20)
```

## Control Flow

### if/else

```koi
if (condition) {
  // code
} else if (otherCondition) {
  // code
} else {
  // code
}
```

Example:

```koi
Agent Validator : Worker {
  on validate(args: Json) {
    if (args.value == null) {
      return { valid: false, error: "Value is required" }
    } else if (args.value < 0) {
      return { valid: false, error: "Value must be positive" }
    } else {
      return { valid: true }
    }
  }
}
```

### for Loop

```koi
for (const item of array) {
  console.log(item)
}
```

Example:

```koi
Agent Processor : Worker {
  on processAll(args: Json) {
    const results = []

    for (const item of args.items) {
      const processed = item * 2
      results.push(processed)
    }

    return { results: results }
  }
}
```

### while Loop

```koi
while (condition) {
  // code
}
```

Example:

```koi
Agent Counter : Worker {
  on countDown(args: Json) {
    const values = []
    const n = args.start

    while (n > 0) {
      values.push(n)
      n = n - 1
    }

    return { values: values }
  }
}
```

### try/catch

```koi
try {
  // risky code
} catch (error) {
  // handle error
}
```

Example:

```koi
Agent SafeProcessor : Worker {
  on process(args: Json) {
    try {
      const result = riskyOperation(args.data)
      return { success: true, result: result }
    } catch (error) {
      console.error("Error:", error.message)
      return { success: false, error: error.message }
    }
  }
}
```

## Functions

### Defining Functions

```koi
function add(a: number, b: number): number {
  return a + b
}

function greet(name: string): string {
  return "Hello, " + name + "!"
}
```

### Using Functions

```koi
Agent Calculator : Worker {
  function multiply(a: number, b: number): number {
    return a * b
  }

  on calculate(args: Json) {
    const product = this.multiply(args.a, args.b)
    return { result: product }
  }
}
```

### Arrow Functions

Not currently supported. Use regular functions instead.

### Async Functions

Use `async` and `await`:

```koi
on asyncHandler(args: Json) {
  const result = await someAsyncOperation(args)
  return result
}
```

## Comments

### Single-line Comments

```koi
// This is a comment
const x = 10  // Comment after code
```

### Multi-line Comments

```koi
/*
 * This is a
 * multi-line comment
 */
const x = 10
```

### Documentation Comments

```koi
/**
 * Processes user data
 * @param args - Input data
 * @returns Processed result
 */
on processData(args: Json) {
  // ...
}
```

## Imports

### TypeScript/JavaScript Imports

Import npm packages or local TypeScript files:

```koi
// npm package
import "lodash"
import "crypto-js"

// local file
import "./utils/helper.ts"
import "../shared/constants.ts"
```

Imported modules are available with underscored names:

```koi
import "lodash"

Agent Example : Worker {
  on process(args: Json) {
    const chunks = lodash.chunk([1, 2, 3, 4], 2)
    return { chunks: chunks }
  }
}
```

See [TypeScript Imports](11-typescript-imports.md) for details.

### Koi File Imports

Import other Koi files (roadmap feature):

```koi
// Future feature
import "./agents/validator.koi"
import "./skills/analysis.koi"
```

## JavaScript Interop

Koi transpiles to JavaScript, so you can use JavaScript features:

```koi
Agent JSInterop : Worker {
  on example(args: Json) {
    // Array methods
    const doubled = [1, 2, 3].map(x => x * 2)
    const filtered = doubled.filter(x => x > 2)

    // Object operations
    const keys = Object.keys(args)
    const values = Object.values(args)

    // JSON
    const json = JSON.stringify({ data: "value" })
    const parsed = JSON.parse(json)

    // Math
    const rounded = Math.round(3.7)
    const random = Math.random()

    // Date
    const now = Date.now()
    const date = new Date()

    return { doubled, filtered }
  }
}
```

## Best Practices

### 1. Use Descriptive Names

```koi
// ✅ Good
const userAge = 30
const isValid = true

// ❌ Bad
const x = 30
const flag = true
```

### 2. Keep Handlers Focused

```koi
// ✅ Good: Single responsibility
on validate(args: Json) {
  return { valid: args.value != null }
}

on transform(args: Json) {
  return { transformed: args.value.toUpperCase() }
}

// ❌ Bad: Doing too much
on processEverything(args: Json) {
  // validate, transform, load, analyze, report...
}
```

### 3. Use Type Annotations

```koi
// ✅ Good
on process(args: Json): Json {
  const result: number = calculate(args)
  return { result: result }
}

// ❌ Bad: No types
on process(args) {
  const result = calculate(args)
  return result
}
```

### 4. Handle Errors

```koi
// ✅ Good
on process(args: Json) {
  try {
    const result = riskyOperation(args)
    return { success: true, result: result }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

// ❌ Bad: No error handling
on process(args: Json) {
  const result = riskyOperation(args)
  return result
}
```

## Limitations

Current syntax limitations (roadmap):

- ❌ No destructuring: `const { name, age } = user`
- ❌ No spread operator: `const all = [...a, ...b]`
- ❌ No optional chaining: `obj?.prop?.nested`
- ❌ No nullish coalescing: `value ?? defaultValue`
- ❌ No classes (use Agents instead)
- ❌ No arrow functions

Workarounds:

```koi
// Instead of destructuring
const name = user.name
const age = user.age

// Instead of spread
const all = a.concat(b)

// Instead of optional chaining
const nested = obj != null && obj.prop != null ? obj.prop.nested : null

// Instead of nullish coalescing
const final = value != null ? value : defaultValue
```

## What's Next?

- **[Agents Guide](03-agents.md)** - Create agents with handlers and state
- **[Roles & Teams](04-roles-and-teams.md)** - Build multi-agent systems
- **[TypeScript Imports](11-typescript-imports.md)** - Use npm packages

---

**Next**: [Agents Guide](03-agents.md) →
