/**
 * Unit tests for Calculator module using Jest
 */

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

    test('should handle negative numbers', () => {
      expect(calc.multiply(-3, 4)).toBe(-12);
    });
  });

  describe('divide', () => {
    test('should divide two numbers', () => {
      expect(calc.divide(10, 2)).toBe(5);
    });

    test('should handle decimal results', () => {
      expect(calc.divide(7, 2)).toBe(3.5);
    });

    test('should throw error on division by zero', () => {
      expect(() => calc.divide(10, 0)).toThrow('Division by zero');
    });
  });

  describe('power', () => {
    test('should calculate power correctly', () => {
      expect(calc.power(2, 3)).toBe(8);
    });

    test('should handle exponent of zero', () => {
      expect(calc.power(5, 0)).toBe(1);
    });

    test('should handle negative exponents', () => {
      expect(calc.power(2, -2)).toBe(0.25);
    });
  });

  describe('percentage', () => {
    test('should calculate percentage correctly', () => {
      expect(calc.percentage(100, 10)).toBe(10);
    });

    test('should handle decimal percentages', () => {
      expect(calc.percentage(200, 2.5)).toBe(5);
    });
  });
});

describe('factorial', () => {
  test('should calculate factorial of 0', () => {
    expect(factorial(0)).toBe(1);
  });

  test('should calculate factorial of 1', () => {
    expect(factorial(1)).toBe(1);
  });

  test('should calculate factorial of 5', () => {
    expect(factorial(5)).toBe(120);
  });

  test('should calculate factorial of 10', () => {
    expect(factorial(10)).toBe(3628800);
  });

  test('should throw error for negative numbers', () => {
    expect(() => factorial(-1)).toThrow('Factorial is not defined for negative numbers');
  });
});

describe('isPrime', () => {
  test('should return false for numbers less than 2', () => {
    expect(isPrime(0)).toBe(false);
    expect(isPrime(1)).toBe(false);
    expect(isPrime(-5)).toBe(false);
  });

  test('should return true for prime numbers', () => {
    expect(isPrime(2)).toBe(true);
    expect(isPrime(3)).toBe(true);
    expect(isPrime(5)).toBe(true);
    expect(isPrime(7)).toBe(true);
    expect(isPrime(11)).toBe(true);
    expect(isPrime(17)).toBe(true);
    expect(isPrime(19)).toBe(true);
  });

  test('should return false for composite numbers', () => {
    expect(isPrime(4)).toBe(false);
    expect(isPrime(6)).toBe(false);
    expect(isPrime(8)).toBe(false);
    expect(isPrime(9)).toBe(false);
    expect(isPrime(10)).toBe(false);
    expect(isPrime(15)).toBe(false);
    expect(isPrime(21)).toBe(false);
  });

  test('should handle large primes', () => {
    expect(isPrime(97)).toBe(true);
    expect(isPrime(100)).toBe(false);
  });
});
