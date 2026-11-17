// `__all__ = ["load"]`, Python's own way of saying what a module exports, and
// the closest thing it has to TypeScript's `export` keyword. Read from the AST,
// so it stays a plain assignment in the source.
//
// **Every statement, in order, and the value that counts is the last one**: a
// module that narrows its list afterwards, with a second `__all__ = [...]` or
// the `+=` a conditional export is written with, exports the list it ends
// with, the one `from m import *` obeys.
//
// What literals spell, Python computes the same on every run, so each such
// statement is run, by Python, rather than read by a copy of its rules.
// Anything else is refused rather than skipped: a declaration that matched
// nothing would fall back to **exporting everything**, a file that states a
// contract and publishes past it.
//
// An entry that is not a string, which CPython itself raises on at
// `from m import *`, is left out while the good ones are kept.
import { refuse } from './errors.js';
import { jsLocal } from './imports.js';
import {
    walkScoped,
    builtinIn,
    scopeIn,
    isGlobalScope,
    moduleBinds,
    READS_ONLY,
    READS_LIST,
    keepsValue,
    handsOnItems,
    handsOutItems,
    subscripts
} from './scopes.js';
import { counterStart, engine, JS_RESERVED, PY_NAME, NS, NEXT_VALUE } from './translation.js';

const isAll = (node) => node instanceof globalThis.__BRYTHON__.ast.Name && node.id === '__all__';

// `__all__`, or an item of it at any depth: `__all__[0][1]` is in the list,
// and a change to it changes what the list ends with.
const withinAll = (node) => isAll(node) || (node instanceof globalThis.__BRYTHON__.ast.Subscript && withinAll(node.value));

// Whether a target writes `__all__`: the name, an item or a slice of it at any
// depth, or either inside a tuple or a starred target.
const targetsAll = (target) => {
    const ast = globalThis.__BRYTHON__.ast;

    return (
        isAll(target) ||
        (target instanceof ast.Subscript && withinAll(target.value)) ||
        (target instanceof ast.Starred && targetsAll(target.value)) ||
        ((target instanceof ast.Tuple || target instanceof ast.List) && target.elts.some(targetsAll))
    );
};

// A method of `str`, as Python finds it, which changes nothing; a list, a dict
// or a set has none of that name that does.
const strMethod = (name) => {
    const $B = globalThis.__BRYTHON__;

    return !name.startsWith('_') && $B.$getattr($B.builtins.str, name, null) !== null;
};

// Whether a node, of any shape, writes `__all__`: a method that changes it or
// an item of it, `__all__[0].append("b")`, an assignment, a deletion, a loop or
// `with` target, a walrus, an import alias, an `except … as` or a `match`
// capture. A read, `return __all__`, is not one, nor a method of `str` on an
// item, `__all__[0].upper()`, which a list of names holds as a string.
const writesAll = (node) => {
    const $B = globalThis.__BRYTHON__;

    if (node instanceof $B.ast.Call) {
        const to = node.func;
        if (!(to instanceof $B.ast.Attribute) || !withinAll(to.value) || READS_LIST.has(to.attr)) return false;
        return isAll(to.value) || !strMethod(to.attr);
    }
    if (node instanceof $B.ast.Assign || node instanceof $B.ast.Delete) return node.targets.some(targetsAll);
    if (node instanceof $B.ast.AugAssign) return targetsAll(node.target);
    if (node instanceof $B.ast.AnnAssign) return Boolean(node.value) && targetsAll(node.target);
    if (node instanceof $B.ast.For || node instanceof $B.ast.AsyncFor) return targetsAll(node.target);
    if (node instanceof $B.ast.withitem) return Boolean(node.optional_vars) && targetsAll(node.optional_vars);
    if (node instanceof $B.ast.NamedExpr) return isAll(node.target);
    if (node instanceof $B.ast.alias) return (node.asname ?? node.name) === '__all__';
    if (node instanceof $B.ast.ExceptHandler) return node.name === '__all__';
    if (node instanceof $B.ast.MatchAs || node instanceof $B.ast.MatchStar) return node.name === '__all__';
    if (node instanceof $B.ast.MatchMapping) return node.rest === '__all__';
    return false;
};

// Every place the source writes `__all__`, and every read that hands the list
// on, `escapes`, where what is done to it next is out of sight. A list of
// strings alone hands on its items and a copy of them as they are, `deep`
// subscripts in (`handsOnItems`), which `deepAt` says where the read stands:
// one, unless a statement made it hold anything else.
function allWrites(ast, builtin = () => false, deepAt = () => Infinity) {
    const $B = globalThis.__BRYTHON__;
    const found = [];

    // An item read off the list is handed on as the list is: a list inside it,
    // `alias = __all__[0]`, is changed through `alias`.
    const item = (node) =>
        node instanceof $B.ast.Subscript && node.ctx instanceof $B.ast.Load && (isAll(node.value) || item(node.value));

    walkScoped(ast.body, (node, scope, line, parent, grand) => {
        if (writesAll(node)) found.push({ node, scope, line });
        if (!((isAll(node) && node.ctx instanceof $B.ast.Load) || item(node))) return;

        const isBuiltin = (name) => builtin(name, scope);
        const deep = deepAt(node, scope);
        // A read that hands the items on, in a copy, `list(__all__)`, or one by
        // one, `for name in __all__`, as a slice does.
        const itemsOut = handsOutItems(parent, grand, node, isBuiltin) && subscripts(node) + 1 < deep;

        if (itemsOut || (!keepsValue(parent, grand, node, isBuiltin) && !handsOnItems(parent, node, deep, deep - 1))) {
            found.push({ node, scope, line, escapes: true, deep });
        }
    });

    return found;
}

// The builtins a statement of `__all__` may call: each reads what it is given
// and keeps nothing, so the call answers the same on every run.
const PURE_BUILTINS = new Set([...READS_ONLY].filter((name) => name !== 'print'));

// What a statement cannot be written with and still give one answer before the
// module runs: a function of its own, a walrus, a comprehension's names, a
// suspension.
const UNSPELLED = ['Lambda', 'NamedExpr', 'ListComp', 'SetComp', 'DictComp', 'GeneratorExp', 'Await', 'Yield', 'YieldFrom'];

// What in a statement keeps its result from being known before the module runs:
// a name read that is neither `__all__` nor a builtin above, or a construct of
// `UNSPELLED`. Null when it is written with literals alone, and Python's
// answer is then the only answer. A name it binds, `x = __all__.pop()`, binds
// it and changes nothing about the list.
//
// The statement runs in the compiler's own process, so an attribute is taken
// only as a method of a value the statement made, `"a b".split()`, or of
// `__all__`: never of a builtin itself, `str.mro()`, and never one spelled with
// `_`, which is the way from any value to the classes behind it. That is what
// the tree spells: a format string reads an attribute by its name,
// `"{0.__class__}".format(1)`, where the tree holds a string, and can show
// what it reads but call none of it. A guard on what a statement writes, not a
// sandbox: the build runs the author's code anyway, in a prerender or a server
// render.
function unspelled(node, pure) {
    const $B = globalThis.__BRYTHON__;

    if (node instanceof $B.ast.Name) {
        const read = !(node.ctx instanceof $B.ast.Store);
        return read && node.id !== '__all__' && !pure(node.id) ? `computed from \`${node.id}\`` : null;
    }
    if (node instanceof $B.ast.Attribute) {
        const chain = [];
        let root = node;
        while (root instanceof $B.ast.Attribute || root instanceof $B.ast.Subscript) {
            if (root instanceof $B.ast.Attribute) chain.unshift(root.attr);
            root = root.value;
        }
        const hidden = chain.find((attr) => attr.startsWith('_'));
        if (hidden !== undefined) return `read through \`${hidden}\``;
        if (root instanceof $B.ast.Name && root.id !== '__all__') return `computed from an attribute of \`${root.id}\``;
    }
    const kind = UNSPELLED.find((one) => node instanceof $B.ast[one]);
    if (kind !== undefined) return `written with a ${kind}`;
    for (const child of children(node)) {
        const found = unspelled(child, pure);
        if (found !== null) return found;
    }
    return null;
}

// What a node holds, by the fields its class declares, as CPython's `ast` walks
// it. Not its own keys: a node also carries `$parent`, and the walk would climb
// back to the module.
const children = (node) =>
    (node?.constructor?._fields ?? []).flatMap((field) => {
        const value = node[field];
        if (Array.isArray(value)) return value.filter((one) => one !== null && typeof one === 'object');
        return value !== null && typeof value === 'object' ? [value] : [];
    });

// Whether a node writes `__all__` anywhere inside it.
const hasWrite = (node) => writesAll(node) || children(node).some(hasWrite);

// Every node a statement holds, so the walk of every write below knows the
// statement was followed.
const nodesOf = (node, into) => {
    into.add(node);
    for (const child of children(node)) nodesOf(child, into);
    return into;
};

// Runs statements as Python runs them, one by one in a namespace of their own,
// and hands back that namespace, or the statement Python raised at with what it
// raised. Each statement is taken from a parse of its own of the same source:
// the module's tree carries the marks its symbol table reads, and a second table
// over it would overwrite them.
//
// Brython's counter is given back afterwards, as a compile gives it back
// around its own run, so that what this runs changes nothing in the code
// generated next. Its tag is not touched: it names lambdas, and a statement of
// `__all__` holds none.
//
// A statement is found in that parse by where it stands, never by its index:
// Brython's code generator takes a module's docstring out of the body it
// compiled, and the two bodies then count differently.
function runStatements(src, statements) {
    const $B = engine();
    const name = '__bryc_all__';
    const tree = $B._PyPegen.run_parser(new $B.Parser(src, name, 'file'));
    const at = (node) => `${node.lineno}:${node.col_offset}`;
    const parsed = new Map(tree.body.map((node) => [at(node), node]));
    const namespace = {};
    const original = $B.namespace;
    const counter = $B.id_counter(counterStart(name));
    const text = (one) => typeof one === 'string' || one instanceof String;
    // Whether `__all__` held strings alone after each statement: none, a
    // string, or a list or a tuple of them.
    const strings = [];

    $B.namespace = (requested) => (requested === name ? namespace : original(requested));
    try {
        for (const statement of statements) {
            const module = new $B.ast.Module([parsed.get(at(statement))], []);
            const symtable = $B._PySymtable_Build(module, name, $B.future_features(module, name));

            try {
                (0, eval)($B.js_from_root({ ast: module, symtable, filename: name, src }).js);
            } catch (error) {
                const raised = error?.ob_type ? `${$B.class_name(error)}: ${$B.builtins.str.$factory(error)}` : String(error);

                return { namespace, statement, raised };
            }

            const value = namespace.__all__;

            strings.push(
                value === undefined ||
                    value === $B.builtins.None ||
                    text(value) ||
                    (($B.is_list(value) || $B.is_tuple(value)) && [...value].every(text))
            );
        }
    } finally {
        $B.namespace = original;
        $B.id_counter(counter);
    }

    return { namespace, strings };
}

// What comes back is the list and the line of the statement that last set it,
// which is where a refusal about the list points.
//
// Each statement of the module's own that writes `__all__` is run as Python runs
// it, when it is written with literals, `__all__` and the builtins above, since
// Python's answer is then the only one: `+= "bc"` adds `b` and `c`, `.append()`
// on a tuple raises. A write this cannot run, anywhere it resolves to the
// module's `__all__`, is refused.
function declaredExports(host, ast, table, source, lineOffset = 0, src = '') {
    const $B = globalThis.__BRYTHON__;
    const body = ast.body;
    const handled = new Set();
    let names = null;
    let line;

    const refuseUnreadable = (node, what) => {
        throw refuse(
            `${host.name} — \`__all__\` is ${what}, and the export list is read from the source ` +
                `before the module runs: a statement at the top level of the module written ` +
                `with literals, \`__all__\`, their methods and the builtins that only read, ` +
                `\`sorted\` or \`list\`, is run as Python runs it, and nothing else can be ` +
                `followed. Write the names, or drop \`__all__\` and let ` +
                `the module export its functions.`,
            source,
            node.lineno === undefined ? undefined : node.lineno + lineOffset
        );
    };

    // A name is the builtin at the top of the module where the module binds
    // nothing of that name and JavaScript gives it none (`builtinIn`).
    const bound = moduleBinds(table);
    const builtin = builtinIn(table, bound);

    // The module's own statements that write `__all__`, in order: a compound
    // one, a condition, a loop, a function, is left to the walk below.
    const simple = ['Assign', 'AugAssign', 'AnnAssign', 'Delete', 'Expr'];
    const run = [];

    for (const node of body) {
        if (!simple.some((kind) => node instanceof $B.ast[kind]) || !hasWrite(node)) continue;

        // A second target may hold the same list, and what is done to it through
        // that name is out of sight: `__all__ = names = []`, or `names, __all__ =
        // [[]] * 2`, then `names.append`.
        const unpacked = (target) => target instanceof $B.ast.Tuple || target instanceof $B.ast.List;

        if (node instanceof $B.ast.Assign && (node.targets.length > 1 || node.targets.some(unpacked))) {
            refuseUnreadable(node, 'assigned to another target as well');
        }

        const why = unspelled(node, (name) => PURE_BUILTINS.has(name) && builtin(name, null));
        if (why !== null) refuseUnreadable(node, why);

        nodesOf(node, handled);
        run.push(node);
    }

    // How deep in `__all__` a read hands on nothing that can change.
    let deepAt = () => Infinity;

    if (run.length) {
        const { namespace, statement, raised, strings } = runStatements(src, run);
        const precedes = (one, node) => one.lineno < node.lineno || (one.lineno === node.lineno && one.col_offset < node.col_offset);
        const last = (node) => strings.findLast((_, index) => precedes(run[index], node)) ?? true;
        const from = (node) => last(node) && strings.every((one, index) => one || precedes(run[index], node));

        // One where it holds strings alone: at the top of the module, as the
        // statements before the read left it, and in a function, called at any
        // time once defined, as each statement from its definition on does.
        deepAt = (node, scope) => ((scope === null ? last(node) : from(scope)) ? 1 : Infinity);

        // Python raises there, at import: the module never runs past it.
        if (raised !== undefined) {
            const at = statement.lineno + lineOffset;

            throw refuse(
                `${host.name} — Python raises \`${raised}\` here when the module is imported, so ` +
                    `\`__all__\` has no value to export (${source}:${at})`,
                source,
                at
            );
        }

        // A list or a tuple is the export list. Anything else, a string or
        // `None`, or no `__all__` at all once `del` has run, is no export
        // list, and the module exports its functions.
        const value = namespace.__all__;

        line = run.at(-1).lineno + lineOffset;

        // A name holding a character past U+FFFF, `𠀀`, is a `String` object
        // here, the storage `pyScalar` reads in the runtime.
        if (value !== undefined && ($B.is_list(value) || $B.is_tuple(value))) {
            names = [...value].map((one) => (one instanceof String ? one.valueOf() : one));

            // An entry that is no string names nothing: left out, it exported
            // nothing and said nothing, where CPython's `from m import *`
            // raises `TypeError: Item in __all__ must be str`.
            const stray = names.find((one) => typeof one !== 'string');

            if (stray !== undefined) {
                const kind = $B.class_name(stray);

                throw refuse(
                    `${host.name} — \`__all__\` lists \`${$B.builtins.repr(stray)}\`, ${/^[aeiou]/i.test(kind) ? 'an' : 'a'} ` +
                        `\`${kind}\`, and an entry of \`__all__\` is a name, a string, ` +
                        `as Python's \`from m import *\` requires (${source}:${line})`,
                    source,
                    line
                );
            }
        }
    }

    // Every other write that reaches the module's `__all__`: under a condition,
    // in a loop, in a function or a class that does not make the name its own,
    // or rebound by a loop, an import or a walrus.
    for (const { node, scope, line: at, escapes, deep } of allWrites(ast, builtin, deepAt)) {
        if (handled.has(node)) continue;

        const block = scope === null ? null : table.blockOf(scope);
        if (block !== null && block !== undefined && !isGlobalScope(scopeIn(block, '__all__'))) continue;

        // A read that hands the list on matters only for a module that has one.
        if (escapes && names === null) continue;

        // A copy shares the items, which are strings only where the list holds
        // nothing else.
        const copied = deep === Infinity ? ', and a copy would share what it holds, which is more than strings' : '; `list(__all__)` is a copy';

        refuseUnreadable(
            { lineno: at },
            escapes ? `handed on where this file cannot follow what is done to it${copied}` : 'changed where this file cannot follow it'
        );
    }

    // A name listed twice is exported once: Python allows the repetition, and
    // JavaScript refuses a duplicate export.
    return names === null ? null : { names: [...new Set(names)], line };
}

// The sentence for a name `__all__` lists and the module does not bind, said by
// the compiler when nothing in the source can bind it, and by the module once
// it has run when a `from m import *` could have.
const neverBinds = (host, name, where) =>
    `${host.name} — \`__all__\` names \`${name}\`, which this module never binds (${where}). A module ` +
    `exports what it defines: check the spelling, or remove it from the list.`;

// What `__all__` lists (`declaration`, `declaredExports`' answer) that the
// module cannot export, refused at the line of the list.
//
// A name the module never binds: Python raises on it at `from m import *` and
// says nothing otherwise; here a reference to a name that does not exist would
// fail the module's evaluation and take everything it exports down with it,
// and the value read off the namespace would be a quiet `undefined`. Bound is
// what the host declared (`declared`), what the symbol table binds (`binds`),
// and a name `__js__` brings (`jsImported`), which the module reads, and so does
// `globals()`. A `from m import *` (`starred`) binds names the source does not
// spell, so with one the question waits until the module has run, and the
// names are handed back (`unbound`, `unboundRefusals`).
//
// And what only a star import can bring that the module cannot export under its
// name: a word JavaScript reserves, or no name at all, refused and named, as a
// binding of a reserved word is, rather than left out of the exports.
function exportChecks(host, { declaration, declared, binds, jsImported, starred, source }) {
    const listed = declaration === null ? null : declaration.names;
    const unbound = (listed ?? []).filter((n) => !declared.includes(n) && !binds.has(n) && !jsImported.includes(n));
    // The name is bound nowhere, so the line is the one `__all__` is on.
    const line = declaration?.line;
    const listedAt = line === undefined ? source : `${source}:${line}`;

    if (unbound.length && !starred) throw refuse(neverBinds(host, unbound[0], listedAt), source, line);

    const unexportable = (listed ?? []).find((n) => !PY_NAME.test(n) || JS_RESERVED.has(n));

    if (unexportable !== undefined) {
        throw refuse(
            `${host.name} — \`__all__\` names \`${unexportable}\`, which ` +
                `${PY_NAME.test(unexportable) ? 'JavaScript reserves' : 'is not a name'}, so the module ` +
                `cannot export it (${listedAt}).`,
            source,
            line
        );
    }

    return { unbound, line, listedAt };
}

// Right after the body has run, the first moment the namespace holds what the
// star imports brought, and before any export reads it: a name `__all__` lists
// that the module has not bound reads `undefined` on the namespace, which is
// what `del` leaves too.
const unboundRefusals = (host, unbound, listedAt) =>
    unbound.map(
        (n) =>
            `if (${NS}[${JSON.stringify(n)}] === undefined) throw new ${host.runtime.jsGlobal}.Error(${JSON.stringify(neverBinds(host, n, listedAt))});`
    );

// What a module exports by name, `exported`, as an ES module's named exports.
//
// A framework reads `load`, `actions`, `GET`, `prerender` by name off a route
// module, so values are exported as well as functions, and a value goes
// through the boundary too: `actions` is a dict of Python functions, each of
// them called by the framework.
//
// No default export: a framework may refuse one on a route module, and a
// Python module has no notion of a default anyway. Named exports are the whole
// contract, and `__all__` is where it is written.
//
// Read off the namespace and not off a JavaScript binding, because only the
// *reactive* names have one: a class, `__all__ = ["Widget"]`, is the author's
// name and correctly not a state. The namespace is where the module body put
// every one of them, and reading it through the accessor gives the reactive
// ones the same value their binding holds. One shape for all of them.
//
// And a live one, as `export let` is in JavaScript: captured once, the export
// went on reading `0` after `bump()` made the name `1`, where `module.read()`
// and another Python module both read `1`. Filled by the body as it binds them
// (`liveExportLines`).
//
// A name only `__js__` brings (`jsImported`) is JavaScript's own binding,
// imported at the top of the module, and it is re-exported as that binding: it
// follows the writes its own module makes, which never pass through Python's
// namespace.
//
// A `def` is published the same way, as the value its name holds now, which is
// what a JavaScript module's `export let` does and what CPython's `from m
// import f` holds: a function as the one wrapper the runtime keeps for it, so
// the same function written again is the same object to an `off()`; a
// decorator's data, a `42` written over it, or nothing after `del`, as data.
// Made once at import, it went on being a function after Python had made the
// name a number, and stayed a number after Python had made it a function again.
const exportCell = (name) => `__export_${name}`;

// An import re-exported from the variable it is held under (`jsLocal`).
function moduleExports(host, { exported, jsImported }) {
    const own = (n) => !jsImported.includes(n);
    const named = (n) => (own(n) ? `${exportCell(n)} as ${n}` : jsLocal(host, n) === n ? n : `${jsLocal(host, n)} as ${n}`);

    return [
        ...exported.filter(own).map((n) => `let ${exportCell(n)};`),
        ...(exported.length ? [`export { ${exported.map(named).join(', ')} };`] : [])
    ];
}

// What fills each export as the body binds its name, the value crossing as
// the runtime hands Python's values to JavaScript, said for `name — source`.
const liveExportLines = (host, { exported, jsImported, source }) =>
    exported
        .filter((n) => !jsImported.includes(n))
        .map(
            (n) =>
                `${host.runtime.liveExport}(${NS}, ${JSON.stringify(n)}, (__value) => { ${exportCell(n)} = ` +
                `${host.runtime.pyExport}(__value, ${JSON.stringify(`${n} — ${source}`)}); });`
        );

// The function that runs a module's body, which an import calls and the
// evaluation of the module does not: `import optional` under an `if` not
// taken, in a function never called or in a `try` runs `optional` at that
// statement, in its order and with its exception (the runtime's
// `pythonModule`). JavaScript that imports the file reaches it through a
// module that calls it as it is evaluated.
//
// What runs moves inside, in the order it ran in (`run`, the host's lines): the
// body, the refusals that read what it bound, the exports it filled, and what
// else the host runs once the body has. The declarations and the `export`
// statements stay where they were, and the function is called once the module
// is evaluated, so it finds all of them. Published under the module's Python
// name (`name`); a name no `import` can write, `+page.server`, is never looked
// up.
//
// The default export, which `export *` leaves out: what JavaScript imports by
// name is what `__all__` says, and nothing of ours beside it.
//
// An eager module (`eager`) has no such export: the function is called as the
// module is evaluated, and the module is its one half, as a framework that
// loads a module when it decides, and refuses a default there, needs.
//
// A body that raises leaves its namespace to whoever holds it, and the next
// import runs in a new one, which the function hands back to be the module's,
// with what the host renews beside it (`renewed`, statements).
//
// A module is published under its name when Python can import it by that name,
// each part between dots an identifier, `pkg.worker` as `worker`; `+page.server`
// is published under none.
function moduleLoad(host, { name, eager = false, run, renewed = [] }) {
    const importable = name.split('.').every((part) => PY_NAME.test(part));

    return [
        ``,
        `${eager ? '' : 'export default '}${host.runtime.pythonModule}(${NS}, ${importable ? JSON.stringify(name) : 'null'}, ` +
            `(${NEXT_VALUE}) => { ${NS} = ${NEXT_VALUE};${renewed.map((one) => ` ${one}`).join('')} }, () => {`,
        ...run.map((line) => (line === '' ? line : `    ${line}`)),
        eager ? `})();` : `});`
    ];
}

export { children, declaredExports, exportChecks, unboundRefusals, exportCell, moduleExports, liveExportLines, moduleLoad };
