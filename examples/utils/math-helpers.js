/**
 * Math helper utilities (TypeScript module)
 */
export function add(a, b) {
    return a + b;
}
export function multiply(a, b) {
    return a * b;
}
export function fibonacci(n) {
    if (n <= 1)
        return n;
    return fibonacci(n - 1) + fibonacci(n - 2);
}
export function isPrime(n) {
    if (n <= 1)
        return false;
    if (n <= 3)
        return true;
    if (n % 2 === 0 || n % 3 === 0)
        return false;
    for (let i = 5; i * i <= n; i += 6) {
        if (n % i === 0 || n % (i + 2) === 0)
            return false;
    }
    return true;
}
export class Calculator {
    constructor() {
        this.history = [];
    }
    add(a, b) {
        const result = a + b;
        this.history.push(`${a} + ${b} = ${result}`);
        return result;
    }
    subtract(a, b) {
        const result = a - b;
        this.history.push(`${a} - ${b} = ${result}`);
        return result;
    }
    getHistory() {
        return [...this.history];
    }
    clearHistory() {
        this.history = [];
    }
}
export const PI = 3.141592653589793;
export const E = 2.718281828459045;
