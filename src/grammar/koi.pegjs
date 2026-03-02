// ============================================================
// ZenScript Grammar - Peggy PEG
// ============================================================

{
  function buildBinaryExpression(head, tail) {
    return tail.reduce((acc, [_, op, __, expr]) => ({
      type: 'BinaryExpression',
      operator: op,
      left: acc,
      right: expr,
      location: location()
    }), head);
  }
}

// ============================================================
// Top-level program
// ============================================================

Program
  = _ decls:Declaration* _ {
      return {
        type: 'Program',
        declarations: decls.filter(d => d !== null),
        location: location()
      };
    }

Declaration
  = ImportDecl
  / RoleDecl
  / TeamDecl
  / AgentDecl
  / SkillDecl
  / MCPDecl
  / PromptDecl
  / RunStatement

// ============================================================
// Import (TypeScript/JavaScript style)
// ============================================================

ImportDecl
  = "import" _ name:Identifier _ ":" _ importType:ImportType _ "from" _ path:StringLiteral _ {
      return { type: 'ImportDecl', what: 'typed_import', name, importType, path, location: location() };
    }
  / "import" _ name:Identifier _ "from" _ path:StringLiteral _ {
      return { type: 'ImportDecl', what: 'named_import', name, path, location: location() };
    }
  / "import" _ name:StringLiteral _ {
      return { type: 'ImportDecl', what: 'module', name, location: location() };
    }

// ============================================================
// Role
// ============================================================

RoleDecl
  = "role" _ name:Identifier _ "{" _ caps:RoleCapabilities _ "}" _ {
      return { type: 'RoleDecl', name, capabilities: caps, location: location() };
    }

RoleCapabilities
  = head:RoleCapability tail:(_ "," _ RoleCapability)* _ ","? {
      return [head, ...tail.map(t => t[3])];
    }

RoleCapability
  = "can" _ name:Identifier {
      return { type: 'Capability', name, location: location() };
    }

// ============================================================
// Team
// ============================================================

TeamDecl
  = "team" _ name:Identifier _ override:TeamOverride? _ "{" _ members:TeamMembers _ "}" _ {
      return { type: 'TeamDecl', name, override, members, location: location() };
    }

TeamOverride
  = "override" _ "{" _ overrides:TeamMembers _ "}" {
      return overrides;
    }

TeamMembers
  = head:TeamMember tail:(_ ","? _ TeamMember)* _ ","? {
      return [head, ...tail.map(t => t[3])];
    }

TeamMember
  = name:Identifier _ (":" / "=") _ value:(MCPAddress / StringLiteral / Identifier) {
      return { name, value, location: location() };
    }

// ============================================================
// MCP (Model Context Protocol) server declaration
// ============================================================

MCPDecl
  = "mcp" _ name:Identifier _ "=" _ config:ObjectLiteral _ {
      return { type: 'MCPDecl', name, config, location: location() };
    }

// ============================================================
// Prompt (first-class prompt declarations)
// ============================================================

PromptDecl
  = exported:("export" _)? "prompt" _ name:Identifier _ params:PromptParams? _ "=" _ content:(ComposeDecl / PromptConcatExpr) _ {
      return {
        type: 'PromptDecl',
        exported: !!exported,
        name,
        params: params || [],
        content,
        location: location()
      };
    }

PromptConcatExpr
  = head:(StringLiteral / Identifier) tail:(_ "+" _ (StringLiteral / Identifier))* {
      if (tail.length === 0) return head;
      const parts = [head, ...tail.map(t => t[3])];
      return { type: 'PromptConcatExpr', parts, location: location() };
    }

PromptParams
  = "(" _ params:PromptParamList? _ ")" { return params || []; }

PromptParamList
  = first:PromptParam rest:(_ "," _ PromptParam)* {
      return [first, ...rest.map(r => r[3])];
    }

PromptParam
  = name:PropertyIdentifier _ ":" _ type:PropertyIdentifier {
      return { name, type };
    }

ComposeDecl
  = "compose" _ params:ComposeParams? _ "{" _ entries:ComposeEntryList? _ "}" {
      const fragmentsEntry = (entries || []).find(e => e.type === 'FragmentsEntry');
      const templateEntry = (entries || []).find(e => e.type === 'TemplateEntry');
      const modelEntry = (entries || []).find(e => e.type === 'ModelEntry');
      return {
        type: 'ComposeDecl',
        params: params || [],
        fragments: fragmentsEntry ? fragmentsEntry.value : [],
        template: templateEntry ? templateEntry.value : '',
        model: modelEntry ? modelEntry.value : null
      };
    }

ComposeParams
  = "(" _ params:ComposeParamList? _ ")" { return params || []; }

ComposeParamList
  = first:Identifier rest:(_ "," _ Identifier)* {
      return [first, ...rest.map(r => r[3])];
    }

ComposeEntryList
  = first:ComposeEntry rest:(_ ComposeEntry)* {
      return [first, ...rest.map(r => r[1])];
    }

ComposeEntry
  = FragmentsEntry
  / TemplateEntry
  / ModelEntry

FragmentsEntry
  = "fragments" _ ":" _ "{" _ pairs:FragmentPairList? _ "}" {
      return { type: 'FragmentsEntry', value: pairs || [] };
    }

FragmentPairList
  = first:FragmentPair rest:(_ "," _ FragmentPair)* _ ","? {
      return [first, ...rest.map(r => r[3])];
    }

FragmentPair
  = name:Identifier _ ":" _ ref:Identifier {
      return { name: name.name, ref: ref.name };
    }

// Template entry (replaces legacy rules keyword)
TemplateEntry
  = "template" _ ":" _ content:StringLiteral {
      return { type: 'TemplateEntry', value: content.value };
    }

ModelEntry
  = "model" _ ":" _ value:StringLiteral {
      return { type: 'ModelEntry', value: value.value };
    }

// ============================================================
// Agent
// ============================================================

AgentDecl
  = "agent" _ name:Identifier _ ":" _ role:Identifier _ "{" _ body:AgentBody _ "}" _ {
      return { type: 'AgentDecl', name, role, body, location: location() };
    }

AgentBody
  = items:(AgentBodyItem)* {
      // Flatten any arrays (for comma-separated uses statements)
      return items.flat();
    }

AgentBodyItem
  = UsesSkill
  / UsesTeam
  / UsesMCP
  / ExposesMCP
  / AffordanceDecl
  / LLMConfig
  / AmnesiaDecl
  / EventHandler
  / StateDecl
  / PlaybookDecl
  / ResilienceDecl
  / ExportFunction

AmnesiaDecl
  = "amnesia" _ "=" _ value:BooleanLiteral _ {
      return { type: 'AmnesiaDecl', value, location: location() };
    }

UsesSkill
  = "uses" _ "skill" _ names:IdentifierList _ {
      return names.map(name => ({ type: 'UsesSkill', skill: name, location: location() }));
    }

UsesTeam
  = "uses" _ "team" _ names:IdentifierList _ {
      return names.map(name => ({ type: 'UsesTeam', team: name, location: location() }));
    }

UsesMCP
  = "uses" _ "mcp" _ names:IdentifierList _ {
      return names.map(name => ({ type: 'UsesMCP', mcp: name, location: location() }));
    }

ExposesMCP
  = "expose" _ "mcp" _ {
      return { type: 'ExposesMCP', location: location() };
    }

// Comma-separated list of identifiers
IdentifierList
  = first:Identifier rest:(_ "," _ Identifier)* {
      return [first, ...rest.map(r => r[3])];
    }

LLMConfig
  = "llm" _ "default" _ "=" _ config:ObjectLiteral _ {
      return { type: 'LLMConfig', config, location: location() };
    }

EventHandler
  = isPrivate:("private" _)? "on" _ event:HandlerName _ "(" _ params:Parameters? _ ")" _ "{" _ body:Statement* _ "}" _ {
      return { type: 'EventHandler', event, params: params || [], body, isPrivate: !!isPrivate, location: location() };
    }

HandlerName
  = name:$([a-zA-Z_][a-zA-Z0-9_]*) &{
      const reserved = ['run', 'import', 'skill', 'role', 'can', 'team', 'agent',
                        'uses', 'llm', 'default', 'on', 'state', 'playbook', 'resilience', 'amnesia', 'mcp', 'prompt',
                        'export', 'async', 'function', 'var', 'const', 'let', 'if', 'else', 'for', 'of', 'in', 'while',
                        'return', 'await', 'send', 'timeout', 'use', 'override', 'affordance',
                        'expose', 'private',
                        'true', 'false', 'null'];
      if (reserved.includes(name.toLowerCase())) {
        error(`'${name}' is a reserved keyword and cannot be used as a handler name.\n` +
              `Use a different name like 'start', 'execute', 'process', or '${name}Handler'.`);
      }
      return true;
    } {
      return { type: 'Identifier', name, location: location() };
    }

StateDecl
  = "state" _ "{" _ fields:StateFields _ "}" _ {
      return { type: 'StateDecl', fields, location: location() };
    }

StateFields
  = head:StateField tail:(_ StateField)* {
      return [head, ...tail.map(t => t[1])];
    }

StateField
  = name:Identifier _ ":" _ type:TypeAnnotation _ init:("=" _ Expression)? _ {
      return {
        name,
        type,
        init: init ? init[2] : null,
        location: location()
      };
    }
  / name:Identifier _ "=" _ init:Expression _ {
      return {
        name,
        type: null,
        init,
        location: location()
      };
    }

PlaybookDecl
  = "playbook" _ name:StringLiteral _ content:StringLiteral _ {
      return { type: 'PlaybookDecl', name, content, location: location() };
    }

ResilienceDecl
  = "resilience" _ name:StringLiteral _ "{" _ props:ResilienceProps _ "}" _ {
      return { type: 'ResilienceDecl', name, properties: props, location: location() };
    }

ResilienceProps
  = head:ResilienceProp tail:(_ ResilienceProp)* {
      return [head, ...tail.map(t => t[1])];
    }

ResilienceProp
  = name:Identifier _ "=" _ value:(Literal / Identifier) _ {
      return { name, value, location: location() };
    }

// ============================================================
// Skill
// ============================================================

SkillDecl
  = "skill" _ name:Identifier _ "{" _ body:SkillBody _ "}" _ {
      // Extract affordance, functions, agents, teams, constants, variables from body
      const affordance = body.find(item => item.type === 'AffordanceDecl');
      const functions = body.filter(item => item.type === 'ExportFunction');
      const agents = body.filter(item => item.type === 'AgentDecl');
      const teams = body.filter(item => item.type === 'TeamDecl');
      const constants = body.filter(item => item.type === 'SkillConstDeclaration');
      const variables = body.filter(item => item.type === 'SkillVariableDeclaration');

      return {
        type: 'SkillDecl',
        name,
        affordance: affordance ? affordance.content.value : null,
        functions,
        agents,
        teams,
        constants,
        variables,
        location: location()
      };
    }

SkillBody
  = items:(SkillBodyItem)* {
      return items;
    }

SkillBodyItem
  = AffordanceDecl
  / AgentDecl
  / TeamDecl
  / SkillConstDeclaration
  / SkillVariableDeclaration
  / ExportFunction
  / NonExportFunction

AffordanceDecl
  = "affordance" _ content:StringLiteral _ {
      return { type: 'AffordanceDecl', content, location: location() };
    }

SkillConstDeclaration
  = "const"i _ pattern:DestructuringPattern _ typeAnnotation:(":" _ TypeAnnotation)? _ "=" _ value:Expression _ {
      return {
        type: 'SkillConstDeclaration',
        pattern,
        typeAnnotation: typeAnnotation ? typeAnnotation[2] : null,
        value,
        location: location()
      };
    }
  / "const"i _ name:Identifier _ typeAnnotation:(":" _ TypeAnnotation)? _ "=" _ value:Expression _ {
      return {
        type: 'SkillConstDeclaration',
        pattern: { type: 'Identifier', name: name.name },
        typeAnnotation: typeAnnotation ? typeAnnotation[2] : null,
        value,
        location: location()
      };
    }

SkillVariableDeclaration
  = "let"i _ pattern:DestructuringPattern _ typeAnnotation:(":" _ TypeAnnotation)? _ init:("=" _ Expression)? _ {
      return {
        type: 'SkillVariableDeclaration',
        pattern,
        typeAnnotation: typeAnnotation ? typeAnnotation[2] : null,
        init: init ? init[2] : null,
        location: location()
      };
    }
  / "let"i _ name:Identifier _ typeAnnotation:(":" _ TypeAnnotation)? _ init:("=" _ Expression)? _ {
      return {
        type: 'SkillVariableDeclaration',
        pattern: { type: 'Identifier', name: name.name },
        typeAnnotation: typeAnnotation ? typeAnnotation[2] : null,
        init: init ? init[2] : null,
        location: location()
      };
    }

DestructuringPattern
  = ObjectDestructuringPattern
  / ArrayDestructuringPattern

ObjectDestructuringPattern
  = "{" _ props:DestructuringPropertyList _ "}" {
      return { type: 'ObjectPattern', properties: props };
    }

DestructuringPropertyList
  = head:DestructuringProperty tail:(_ "," _ DestructuringProperty)* {
      return [head, ...tail.map(t => t[3])];
    }

DestructuringProperty
  = key:Identifier _ ":" _ value:Identifier {
      return { key: key.name, value: value.name };
    }
  / name:Identifier {
      return { key: name.name, value: name.name };
    }

ArrayDestructuringPattern
  = "[" _ elements:DestructuringElementList _ "]" {
      return { type: 'ArrayPattern', elements };
    }

DestructuringElementList
  = head:Identifier tail:(_ "," _ Identifier)* {
      return [head.name, ...tail.map(t => t[3].name)];
    }

NonExportFunction
  = isAsync:("async"i _)? "function"i _ name:Identifier _ "(" _ params:Parameters? _ ")" _ ":" _ returnType:TypeAnnotation _ "{" body:FunctionBody "}" _ {
      return {
        type: 'ExportFunction',
        name,
        isExport: false,
        isAsync: !!isAsync,
        params: params || [],
        returnType,
        body: { code: body },
        location: location()
      };
    }
  / isAsync:("async"i _)? "function"i _ name:Identifier _ "(" _ params:Parameters? _ ")" _ "{" body:FunctionBody "}" _ {
      return {
        type: 'ExportFunction',
        name,
        isExport: false,
        isAsync: !!isAsync,
        params: params || [],
        returnType: null,
        body: { code: body },
        location: location()
      };
    }

ExportFunction
  = "export" _ isAsync:("async"i _)? "function"i _ name:Identifier _ "(" _ params:Parameters? _ ")" _ ":" _ returnType:TypeAnnotation _ "{" body:FunctionBody "}" _ {
      return {
        type: 'ExportFunction',
        name,
        isExport: true,
        isAsync: !!isAsync,
        params: params || [],
        returnType,
        body: { code: body },
        location: location()
      };
    }

// Capture function body as raw text (handles nested braces)
FunctionBody
  = body:$((FunctionBodyChar)*) {
      return body.trim();
    }

FunctionBodyChar
  = "{" FunctionBody "}"  // Nested braces
  / [^{}]                 // Any character except braces

// ============================================================
// Statements
// ============================================================

Statement
  = PlaybookStatement
  / AffordanceStatement
  / VariableDeclaration
  / ConstDeclaration
  / TryStatement
  / IfStatement
  / ForStatement
  / WhileStatement
  / ReturnStatement
  / ThrowStatement
  / SendStatement
  / UsePlaybookStatement
  / ExpressionStatement

PlaybookStatement
  = "playbook" _ parts:PlaybookParts _ {
      return { type: 'PlaybookStatement', parts, location: location() };
    }

AffordanceStatement
  = "affordance" _ content:StringLiteral _ {
      return { type: 'AffordanceStatement', content, location: location() };
    }

PlaybookParts
  = first:PlaybookPart rest:(_ "+" _ PlaybookPart)* {
      return [first, ...rest.map(r => r[3])];
    }

PlaybookPart
  = call:PromptCallExpr { return call; }
  / content:StringLiteral { return { type: 'StringPart', content, location: location() }; }
  / name:Identifier { return { type: 'PromptRef', name, location: location() }; }

PromptCallExpr
  = name:Identifier "(" _ args:PromptCallArgs? _ ")" {
      return { type: 'PromptCall', name, args: args || [], location: location() };
    }

PromptCallArgs
  = first:PromptCallArg rest:(_ "," _ PromptCallArg)* {
      return [first, ...rest.map(r => r[3])];
    }

PromptCallArg
  = content:StringLiteral { return { type: 'StringLiteral', value: content.value }; }
  / obj:Identifier "." prop:PropertyIdentifier { return { type: 'PropAccess', obj, prop }; }
  / name:Identifier { return { type: 'VarRef', name }; }

VariableDeclaration
  = "var"i _ name:Identifier _ ":" _ type:TypeAnnotation _ init:("=" _ Expression)? _ {
      return {
        type: 'VariableDeclaration',
        name,
        varType: type,
        init: init ? init[2] : null,
        location: location()
      };
    }

ConstDeclaration
  = "const"i _ name:Identifier _ "=" _ value:Expression _ {
      return { type: 'ConstDeclaration', name, value, location: location() };
    }
  / "let"i _ name:Identifier _ "=" _ value:Expression _ {
      return { type: 'VariableDeclaration', name, init: value, varType: null, location: location() };
    }

IfStatement
  = "if"i _ cond:Expression _ "{" _ then:Statement* _ "}" _ alt:ElseClause? _ {
      return { type: 'IfStatement', condition: cond, then, else: alt, location: location() };
    }

ElseClause
  = "else"i _ "{" _ body:Statement* _ "}" {
      return body;
    }

TryStatement
  = "try"i _ "{" _ body:Statement* _ "}" _ handler:CatchClause? _ finalizer:FinallyClause? _ &{
      return !!(handler || finalizer);
    } {
      return { type: 'TryStatement', body, handler, finalizer, location: location() };
    }

CatchClause
  = "catch"i _ "(" _ param:Identifier _ ")" _ "{" _ body:Statement* _ "}" {
      return { type: 'CatchClause', param, body, location: location() };
    }

FinallyClause
  = "finally"i _ "{" _ body:Statement* _ "}" {
      return body;
    }

ForStatement
  = "for"i _ "(" _ decl:("const"i / "let"i / "var"i) _ id:Identifier _ "of"i _ expr:Expression _ ")" _ "{" _ body:Statement* _ "}" _ {
      return { type: 'ForOfStatement', declaration: decl, id, expression: expr, body, location: location() };
    }
  / "for"i _ "(" _ decl:("const"i / "let"i / "var"i) _ id:Identifier _ "in"i _ expr:Expression _ ")" _ "{" _ body:Statement* _ "}" _ {
      return { type: 'ForInStatement', declaration: decl, id, expression: expr, body, location: location() };
    }
  / "for"i _ "(" _ init:ForInit? _ ";" _ cond:Expression? _ ";" _ update:Expression? _ ")" _ "{" _ body:Statement* _ "}" _ {
      return { type: 'ForStatement', init, condition: cond, update, body, location: location() };
    }

ForInit
  = VariableDeclaration
  / ConstDeclaration
  / Expression

WhileStatement
  = "while"i _ cond:Expression _ "{" _ body:Statement* _ "}" _ {
      return { type: 'WhileStatement', condition: cond, body, location: location() };
    }

ReturnStatement
  = "return"i _ value:Expression? _ {
      return { type: 'ReturnStatement', value, location: location() };
    }

ThrowStatement
  = "throw"i _ value:Expression _ {
      return { type: 'ThrowStatement', argument: value, location: location() };
    }

SendStatement
  = "await"i _ "send"i _ target:SendTarget _ args:CallArguments _ timeout:TimeoutClause? _ {
      return { type: 'SendStatement', target, arguments: args, timeout, location: location() };
    }

SendTarget
  = base:PrimaryExpression filters:SendFilter* {
      return { base, filters, location: location() };
    }

SendFilter
  = _ "." "event"i "(" _ name:StringLiteral _ ")" {
      return { type: 'EventFilter', event: name, location: location() };
    }
  / _ "." "role"i "(" _ role:Identifier _ ")" {
      return { type: 'RoleFilter', role, location: location() };
    }
  / _ "." "any"i "(" _ ")" {
      return { type: 'SelectionFilter', mode: 'any', location: location() };
    }
  / _ "." "all"i "(" _ ")" {
      return { type: 'SelectionFilter', mode: 'all', location: location() };
    }

TimeoutClause
  = "timeout"i _ value:Integer unit:TimeUnit {
      return { value, unit, location: location() };
    }

TimeUnit
  = "ms"i / "s"i / "m"i / "h"i

UsePlaybookStatement
  = "use" _ "playbook" _ name:(Identifier / StringLiteral) _ {
      return { type: 'UsePlaybookStatement', name, location: location() };
    }

ExpressionStatement
  = expr:Expression _ {
      return { type: 'ExpressionStatement', expression: expr, location: location() };
    }

// ============================================================
// Expressions
// ============================================================

Expression
  = AssignmentExpression
  / ConditionalExpression

ConditionalExpression
  = test:LogicalOrExpression _ "?" _ consequent:Expression _ ":" _ alternate:Expression {
      return { type: 'ConditionalExpression', test, consequent, alternate, location: location() };
    }
  / LogicalOrExpression

AssignmentExpression
  = left:AssignmentTarget _ op:("=" / "+=" / "-=" / "*=" / "/=" / "%=") _ right:Expression {
      return { type: 'AssignmentExpression', operator: op, left, right, location: location() };
    }

AssignmentTarget
  = ChainedExpression
  / Identifier

LogicalOrExpression
  = head:LogicalAndExpression tail:(_ ("||") _ LogicalAndExpression)* {
      return buildBinaryExpression(head, tail);
    }

LogicalAndExpression
  = head:EqualityExpression tail:(_ ("&&") _ EqualityExpression)* {
      return buildBinaryExpression(head, tail);
    }

EqualityExpression
  = head:RelationalExpression tail:(_ ("===" / "!==" / "==" / "!=") _ RelationalExpression)* {
      return buildBinaryExpression(head, tail);
    }

RelationalExpression
  = head:AdditiveExpression tail:(_ ("<=" / ">=" / "<" / ">" / "instanceof"i) _ AdditiveExpression)* {
      return buildBinaryExpression(head, tail);
    }

AdditiveExpression
  = head:MultiplicativeExpression tail:(_ ("+" / "-") _ MultiplicativeExpression)* {
      return buildBinaryExpression(head, tail);
    }

MultiplicativeExpression
  = head:UnaryExpression tail:(_ ("*" / "/" / "%") _ UnaryExpression)* {
      return buildBinaryExpression(head, tail);
    }

UnaryExpression
  = AwaitExpression
  / NewExpression
  / op:("!" / "-") _ expr:UnaryExpression {
      return { type: 'UnaryExpression', operator: op, argument: expr, location: location() };
    }
  / PostfixExpression

NewExpression
  = "new" _ callee:MemberOrPrimary args:CallArguments {
      return { type: 'NewExpression', callee, arguments: args, location: location() };
    }

// Member or Primary for new expressions (no call arguments included)
MemberOrPrimary
  = base:PrimaryExpression props:PropertyAccessOnly+ {
      return props.reduce((obj, acc) => ({
        type: 'MemberExpression',
        object: obj,
        property: acc.property,
        computed: acc.computed,
        location: location()
      }), base);
    }
  / PrimaryExpression

PropertyAccessOnly
  = "." _ prop:Identifier {
      return { property: prop, computed: false };
    }
  / "[" _ prop:Expression _ "]" {
      return { property: prop, computed: true };
    }

PostfixExpression
  = ChainedExpression
  / PrimaryExpression

// Chained expressions support method calls and property access in any order
// Examples: obj.method(), obj.prop.method(), obj.method().prop, obj.method().method2()
ChainedExpression
  = base:PrimaryExpression chain:ChainElement+ {
      return chain.reduce((obj, element) => {
        if (element.type === 'call') {
          return { type: 'CallExpression', callee: obj, arguments: element.args, optional: element.optional, location: location() };
        } else if (element.type === 'member') {
          return { type: 'MemberExpression', object: obj, property: element.property, computed: element.computed, optional: element.optional, location: location() };
        }
        return obj;
      }, base);
    }

ChainElement
  = "?." _ prop:PropertyIdentifier {
      return { type: 'member', property: prop, computed: false, optional: true };
    }
  / "." _ prop:PropertyIdentifier {
      return { type: 'member', property: prop, computed: false, optional: false };
    }
  / "?.[" _ prop:Expression _ "]" {
      return { type: 'member', property: prop, computed: true, optional: true };
    }
  / "[" _ prop:Expression _ "]" {
      return { type: 'member', property: prop, computed: false, optional: false };
    }
  / "?." _ args:CallArguments {
      return { type: 'call', args, optional: true };
    }
  / args:CallArguments {
      return { type: 'call', args, optional: false };
    }

CallArguments
  = "(" _ args:ArgumentList? _ ")" {
      return args || [];
    }

ArgumentList
  = head:Expression tail:(_ "," _ Expression)* _ ","? {
      return [head, ...tail.map(t => t[3])];
    }

// Keep old MemberExpression for backwards compatibility (not used directly anymore)
MemberExpression
  = object:PrimaryExpression props:PropertyAccess+ {
      return props.reduce((obj, acc) => ({
        type: 'MemberExpression',
        object: obj,
        property: acc.property,
        computed: acc.computed,
        location: location()
      }), object);
    }

PropertyAccess
  = "." prop:Identifier {
      return { property: prop, computed: false };
    }
  / "[" _ prop:Expression _ "]" {
      return { property: prop, computed: true };
    }

PrimaryExpression
  = ArrowFunction
  / Identifier
  / Literal
  / ObjectLiteral
  / ArrayLiteral
  / "(" _ expr:Expression _ ")" { return expr; }

AwaitExpression
  = "await"i _ "send"i _ target:SendTarget _ args:CallArguments _ timeout:TimeoutClause? {
      return { type: 'AwaitExpression', target, arguments: args, timeout, location: location() };
    }
  / "await"i _ expr:PostfixExpression {
      return { type: 'AwaitExpression', argument: expr, location: location() };
    }

ArrowFunction
  = isAsync:("async"i _)? "(" _ params:ParameterList? _ ")" _ "=>" _ body:ArrowBody {
      return { type: 'ArrowFunction', params: params || [], body, isAsync: !!isAsync, location: location() };
    }
  / isAsync:("async"i _)? param:Identifier _ "=>" _ body:ArrowBody {
      return { type: 'ArrowFunction', params: [param], body, isAsync: !!isAsync, location: location() };
    }

ParameterList
  = head:Identifier tail:(_ "," _ Identifier)* {
      return [head, ...tail.map(t => t[3])];
    }

ArrowBody
  = "{" _ stmts:Statement* _ "}" {
      return { type: 'BlockStatement', statements: stmts, location: location() };
    }
  / expr:Expression {
      return expr;
    }

// ============================================================
// Literals
// ============================================================

Literal
  = MCPAddress
  / TemplateLiteral
  / StringLiteral
  / RegexLiteral
  / NumberLiteral
  / BooleanLiteral
  / NullLiteral

MCPAddress
  = "mcp://" server:$([a-zA-Z0-9.-]+) "/" path:$([a-zA-Z0-9/_.-]*) {
      return {
        type: 'MCPAddress',
        server,
        path,
        address: `mcp://${server}/${path}`,
        location: location()
      };
    }

TemplateLiteral
  = "`" parts:TemplatePart* "`" {
      return { type: 'TemplateLiteral', parts, location: location() };
    }

TemplatePart
  = "${" _ expr:Expression _ "}" {
      return { type: 'TemplateExpression', expression: expr, location: location() };
    }
  / chars:TemplateChar+ {
      return { type: 'TemplateString', value: chars.join(''), location: location() };
    }

TemplateChar
  = !("${" / "`" / "\\") char:. { return char; }
  / "\\" seq:EscapeSequence { return seq; }

StringLiteral
  = "\"\"\"" content:TripleStringContent "\"\"\"" {
      return { type: 'StringLiteral', value: content.trim(), multiline: true, location: location() };
    }
  / "\"" chars:DoubleStringChar* "\"" {
      return { type: 'StringLiteral', value: chars.join(''), multiline: false, location: location() };
    }
  / "'" chars:SingleStringChar* "'" {
      return { type: 'StringLiteral', value: chars.join(''), multiline: false, location: location() };
    }

// Triple-quoted string content: allows nested """...""" pairs (e.g. Python docstrings in code examples)
TripleStringContent
  = parts:(TripleStringNested / TripleStringChar)* { return parts.join(''); }

TripleStringNested
  = "\"\"\"" content:TripleStringContent "\"\"\"" { return '"""' + content + '"""'; }

TripleStringChar
  = !"\"\"\"" char:. { return char; }

DoubleStringChar
  = !("\"" / "\\") char:. { return char; }
  / "\\" seq:EscapeSequence { return seq; }

SingleStringChar
  = !("'" / "\\") char:. { return char; }
  / "\\" seq:EscapeSequence { return seq; }

RegexLiteral
  = "/" pattern:RegexPattern "/" flags:RegexFlags? {
      return { type: 'RegexLiteral', pattern, flags: flags || '', location: location() };
    }

RegexPattern
  = chars:RegexChar* { return chars.join(''); }

RegexChar
  = "\\" char:. { return "\\" + char; }  // Escaped character (including \/)
  / ![/\n\r] char:. { return char; }      // Any character except / and newlines

RegexFlags
  = flags:$[gimsuvy]+ { return flags; }

EscapeSequence
  = "n" { return "\n"; }
  / "t" { return "\t"; }
  / "r" { return "\r"; }
  / "\\" { return "\\"; }
  / "\"" { return "\""; }
  / "'" { return "'"; }

NumberLiteral
  = value:Float {
      return { type: 'NumberLiteral', value: parseFloat(value), location: location() };
    }
  / value:Integer {
      return { type: 'NumberLiteral', value: parseInt(value, 10), location: location() };
    }

Float
  = Integer "." Digit+ { return text(); }

Integer
  = Digit+ { return text(); }

BooleanLiteral
  = "true"i {
      return { type: 'BooleanLiteral', value: true, location: location() };
    }
  / "false"i {
      return { type: 'BooleanLiteral', value: false, location: location() };
    }

NullLiteral
  = "null"i {
      return { type: 'NullLiteral', value: null, location: location() };
    }

ObjectLiteral
  = "{" _ props:PropertyList? _ "}" {
      return { type: 'ObjectLiteral', properties: props || [], location: location() };
    }

PropertyList
  = head:Property tail:(_ "," _ Property)* _ ","? {
      return [head, ...tail.map(t => t[3])];
    }

Property
  = "..." _ expr:Expression {
      return { type: 'SpreadProperty', argument: expr, location: location() };
    }
  / key:(Identifier / StringLiteral / PropertyKey) _ ":" _ value:Expression {
      return { key, value, location: location() };
    }

PropertyKey
  = name:$("$"? [a-zA-Z_][a-zA-Z0-9_]*) {
      return { name, type: 'Identifier', location: location() };
    }

ArrayLiteral
  = "[" _ elements:ArgumentList? _ "]" {
      return { type: 'ArrayLiteral', elements: elements || [], location: location() };
    }

// ============================================================
// Types
// ============================================================

TypeAnnotation
  = UnionType
  / PostfixType

UnionType
  = head:PostfixType tail:(_ "|" _ PostfixType)+ {
      return { type: 'UnionType', types: [head, ...tail.map(t => t[3])], location: location() };
    }

PostfixType
  = base:PrimaryType suffixes:(_ "[" _ "]")+ {
      // Apply array type for each []
      return suffixes.reduce((type) => {
        return { type: 'ArrayTypeAnnotation', elementType: type, location: location() };
      }, base);
    }
  / PrimaryType

PrimaryType
  = PromiseType
  / ArrayTypeAnnotation
  / ObjectTypeAnnotation
  / PrimitiveType

ObjectTypeAnnotation
  = "{" _ props:TypePropertyList _ "}" {
      return { type: 'ObjectTypeAnnotation', properties: props, location: location() };
    }

TypePropertyList
  = head:TypeProperty tail:(_ "," _ TypeProperty)* _ ","? {
      return [head, ...tail.map(t => t[3])];
    }

TypeProperty
  = name:PropertyIdentifier _ optional:"?"? _ ":" _ type:TypeAnnotation {
      return { name: name.name, type, optional: !!optional };
    }

ArrayTypeAnnotation
  = "Array"i _ "<" _ elem:TypeAnnotation _ ">" {
      return { type: 'ArrayTypeAnnotation', elementType: elem, location: location() };
    }

PromiseType
  = "Promise"i _ "<" _ inner:TypeAnnotation _ ">" {
      return { type: 'TypeAnnotation', name: 'Promise', inner, location: location() };
    }

PrimitiveType
  = "boolean"i !IdentifierPart { return { type: 'BooleanType', location: location() }; }
  / "number"i !IdentifierPart { return { type: 'NumberType', location: location() }; }
  / "string"i !IdentifierPart { return { type: 'StringType', location: location() }; }
  / "void"i !IdentifierPart { return { type: 'VoidType', location: location() }; }
  / "any"i !IdentifierPart { return { type: 'AnyType', location: location() }; }
  / "null"i !IdentifierPart { return { type: 'NullType', location: location() }; }
  / "undefined"i !IdentifierPart { return { type: 'UndefinedType', location: location() }; }
  / "Int"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'Int', location: location() }; }
  / "String"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'String', location: location() }; }
  / "Bool"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'Bool', location: location() }; }
  / "Json"i !IdentifierPart { return { type: 'TypeAnnotation', name: 'Json', location: location() }; }
  / name:Identifier {
      return { type: 'TypeAnnotation', name: name.name, location: location() };
    }

// ============================================================
// Parameters
// ============================================================

Parameters
  = head:Parameter tail:(_ "," _ Parameter)* _ ","? {
      return [head, ...tail.map(t => t[3])];
    }

Parameter
  = name:Identifier _ ":" _ type:TypeAnnotation _ defaultValue:("=" _ Expression)? {
      return { name, type, default: defaultValue ? defaultValue[2] : null, location: location() };
    }
  / name:Identifier {
      return { name, type: null, default: null, location: location() };
    }

// ============================================================
// Run Statement
// ============================================================

RunStatement
  = "run" _ target:MemberExpression args:CallArguments _ {
      return { type: 'RunStatement', target, arguments: args, location: location() };
    }

// ============================================================
// Identifiers
// ============================================================

Identifier
  = !ReservedWord name:$([a-zA-Z_][a-zA-Z0-9_]*) {
      return { type: 'Identifier', name, location: location() };
    }

// PropertyIdentifier: allows reserved words as property names (after .)
// Examples: obj.state, obj.default, this.state
PropertyIdentifier
  = name:$([a-zA-Z_][a-zA-Z0-9_]*) {
      return { type: 'Identifier', name, location: location() };
    }

// ImportType: allows reserved words as type annotations in typed imports
// Examples: import x: prompt from "...", import x: Json from "..."
ImportType
  = name:$([a-zA-Z_][a-zA-Z0-9_]*) {
      return { type: 'Identifier', name, location: location() };
    }

ReservedWord
  = ("import" / "skill" / "role" / "can" / "team" / "agent" / "skill" /
     "uses" / "llm" / "default" / "on" / "state" / "playbook" / "resilience" / "mcp" / "prompt" /
     "export" / "async" / "function" / "var" / "const" / "let" / "if" / "else" / "for" / "of" / "in" / "while" /
     "try" / "catch" / "finally" / "throw" / "instanceof" /
     "return" / "await" / "send" / "timeout" / "use" / "run" /
     "override" / "affordance" / "amnesia" / "expose" / "private" / "true" / "false" / "null") !IdentifierPart

IdentifierPart
  = [a-zA-Z0-9_]

Digit
  = [0-9]

// ============================================================
// Whitespace and Comments
// ============================================================

_
  = (WhiteSpace / LineTerminator / Comment)*

WhiteSpace
  = [ \t\r\n]

LineTerminator
  = [\n\r]

Comment
  = "//" (!LineTerminator .)*
  / "/*" (!"*/" .)* "*/"
