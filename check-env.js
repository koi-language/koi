#!/usr/bin/env node

console.log('🔍 Checking environment variables...\n');

console.log('Process ENV variables:');
console.log('  OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '✅ SET (length: ' + process.env.OPENAI_API_KEY.length + ')' : '❌ NOT SET');
console.log('  ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? '✅ SET (length: ' + process.env.ANTHROPIC_API_KEY.length + ')' : '❌ NOT SET');

console.log('\nShell environment:');
console.log('  SHELL:', process.env.SHELL);
console.log('  NODE_VERSION:', process.version);

console.log('\nHow to set environment variables:');
console.log('  Option 1 - Export in current shell:');
console.log('    export OPENAI_API_KEY="your-key-here"');
console.log('    koi run examples/hello-world.koi');
console.log('\n  Option 2 - Inline for single command:');
console.log('    OPENAI_API_KEY="your-key-here" koi run examples/hello-world.koi');
console.log('\n  Option 3 - Create .env file:');
console.log('    echo "OPENAI_API_KEY=your-key-here" > .env');
console.log('    koi run examples/hello-world.koi');
