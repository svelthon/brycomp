// @vitest-environment node
//
// What a compile hands back (`compile`): Brython's translation of the source, a
// Python error made a refusal on its line, the source map, the module that
// holds the code and the namespace it runs in, and a component's Python, its
// script with the template's functions after it. And how a name of the module
// is held, which the host writes with Brycomp's accessors.
import { test, expect } from 'vitest';
import * as brycomp from '../src/brycomp.js';

// A host that makes a state as Vue does, a ref its `triggerRef` moves.
const host = {
    name: 'host',
    bridge: 'host/bridge',
    runtime: {
        jsGlobal: 'globalThis',
        bind: 'bind',
        SHAPING: 'SHAPING',
        followOwn: 'followOwn',
        track: 'track',
        changesNothing: 'changesNothing'
    },
    state: {
        cell: (name, cell, bumped) => [`const ${cell} = shallowRef(undefined);`, `const ${bumped} = () => triggerRef(${cell});`],
        value: (cell) => `${cell}.value`,
        read: (name, cell) => `${cell}.value`,
        write: (cell, value) => `${cell}.value = ${value}`
    }
};
const NS = brycomp.NS;
const next = brycomp.NEXT_VALUE;

// **A name JavaScript gives the module is read as the module reads its own**,
// even spelled like a builtin: `max` imported from JavaScript and then called
// is the import, as `from m import max` is in Python, where Brython would take
// a name nothing in the module binds for the builtin. A name that is no
// builtin, and a source with none, compile as written.
const options = { name: 'probe', source: 'src/probe.py' };
const js = (more) => brycomp.compile(host, 'x = max(1, 2)\n', { ...options, ...more }).js;

test("a JavaScript name spelled like a builtin is read off the module's namespace", () => {
    expect(js({ jsNames: ['max'] })).toContain("$B.resolve_global('max'");
    expect(js({ jsNames: ['max'] })).not.toContain('_b_.max');
});

test('a name that is no builtin leaves the code as Brython wrote it', () => {
    expect(js({ jsNames: ['shuffle'] })).toBe(js());
    expect(js()).toContain('_b_.max');
});

// A named escape, `\N{BULLET}`, in a string and in an f-string, is the
// character, as CPython reads it: the engine fetches the names of Unicode
// characters by a request Node does not have, and the compile failed with
// "XMLHttpRequest is not defined"; they are read off Bryvend instead.
test('a named Unicode escape compiles to its character under Node', () => {
    const code = brycomp.compile(host, 'dot = "\\N{BULLET}"\nline = f"\\N{EM DASH} {dot}"\n', options).js;

    expect(code).toContain('•');
    expect(code).toContain('—');
});

// **A Python error at compile time is a refusal on the line of the file that
// holds it**: Brython's own message, under the host's name, at the Python line
// moved by what stands before the Python in its file, on the error object as
// an editor reads it as well as in the sentence. In a template's function it is
// the markup's line and column, with the expression quoted and what Python
// writes instead of the JavaScript in it.
const refusal = (text, more) => {
    try {
        brycomp.compile(host, text, { ...options, ...more });
    } catch (error) {
        return error;
    }

    throw new Error('compiled');
};

test('a syntax error is refused at its line, moved by what stands before the Python', () => {
    const error = refusal('x = 1\ny = (\n', { lineOffset: 10 });

    expect(error).toBeInstanceOf(SyntaxError);
    expect(error.message).toMatch(/^host — SyntaxError: .* \(src\/probe\.py:12\)$/);
    expect(error.filename).toBe('src/probe.py');
    expect(error.start).toEqual({ line: 12, column: 0 });
});

test("an error in a template's function is refused at the markup, the expression quoted", () => {
    // The function stands on Python lines 3 to 4, after the script's line and
    // the blank one the join leaves, and its expression on line 7, column 5, of
    // the markup.
    const error = refusal('x = 1\n', {
        component: true,
        defs: ['def __brycomp_expr_0():\n    return __brycomp_text(a ? b : c)'],
        defLines: [7],
        defColumns: [4]
    });

    expect(error.message).toMatch(/^host — SyntaxError: .* \(src\/probe\.py:7:5\)\n {2}in the template expression `a \? b : c`, which is Python: `a \? b : c` is `b if a else c`\.$/);
    expect(error.start).toEqual({ line: 7, column: 4 });
});

// So is a refusal of what Python accepts, a call that cannot run in the page.
test("a refusal in a template's function stands on the markup's line", () => {
    const error = refusal('x = 1\n', { component: true, defs: ['def __brycomp_expr_0():\n    return eval("2")'], defLines: [100], defColumns: [6] });

    expect([error.message.match(/\(src\/probe\.py:\d+\)/)?.[0], error.start?.line]).toEqual(['(src/probe.py:100)', 100]);
});

// **A table of names is asked for its own**: a method called `toString` or
// `hasOwnProperty`, a JavaScript object's, was taken for one that imports a
// module, the one `Object.prototype` held under that name, and refused; and
// `help("toString")` was no name pydoc must look up, where every other unknown
// one is.
test('a method spelled like a property of Object.prototype is no library call', () => {
    for (const call of ['document.toString()', 'window.hasOwnProperty("name")', 'window.constructor()']) {
        expect(() => brycomp.compile(host, `from browser import document, window\nx = ${call}\n`, options)).not.toThrow();
    }
    expect(refusal('help("toString")\n').message).toMatch(/`help\("toString"\)` looks the name up with `pydoc`/);
    expect(refusal('help("constructor")\n').message).toMatch(/`help\("constructor"\)` looks the name up with `pydoc`/);
});

// A binding is dated by the statement that makes it, however deep its target:
// `b` is the module `builtins` while the value of `((b,), slot) = …` is
// computed, and `b.eval` is refused there as in `b, slot = …`.
test('a builtin read off the module while a nested target rebinds its name is refused', () => {
    for (const statement of [
        'b, slot = b.eval, 0',
        '((b,), slot) = ((b.eval,), 0)',
        '(((b,),), slot) = (((b.open,),), 0)',
        '[*b] = [b.eval]',
        'for ((b,), slot) in [((b.eval,), 0)]:\n    pass'
    ]) {
        expect(refusal(`import builtins as b\n${statement}\n`).message).toMatch(/`(eval|open)\(\)`|\(src\/probe\.py:2\)/);
    }
    expect(() => brycomp.compile(host, 'import builtins as b\n\nclass Api:\n    def open(self, x):\n        return x\n\n((b,), slot) = ((Api(),), 0)\nb.open("value")\n', options)).not.toThrow();
});

// A name JavaScript gives the module is no builtin, for a refusal as for the
// translation: `importjs {open}` calls the import.
test('a JavaScript name spelled like a refused builtin is called as the import', () => {
    for (const name of ['open', 'exec', 'compile', '__import__', 'help']) {
        const call = `observed = ${name}("value")\n`;

        expect(() => brycomp.compile(host, `__js__ = {"./api.js": ["${name}"]}\n${call}`, options)).not.toThrow();
        expect(() => brycomp.compile(host, call, { ...options, jsNames: [name] })).not.toThrow();
    }
    expect(refusal('observed = open("value")\n').message).toMatch(/`open\(\)`/);
});

test('a source that compiles is Brython\'s translation of it', () => {
    expect(brycomp.compile(host, 'total = 1 + 2\n', options).js).toContain('$B.set_lineno(frame, 1)');
});

// **Each line of the generated code maps to the Python line it came from**,
// which Brython writes into the code as `$B.set_lineno(frame, N)`: from that
// call on, every generated line is the line N of the Python, moved by the lines
// that stand before the Python in its file. A line before the first call maps
// to nothing.
const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// The source line of each generated line, by reading the map back as a source
// map is read: base-64 VLQ, each field a delta from the one before.
const originalLines = (mappings) => {
    let line = 0;

    return mappings.split(';').map((segment) => {
        if (segment === '') return null;

        const fields = [];
        let value = 0;
        let shift = 0;

        for (const char of segment) {
            const digit = DIGITS.indexOf(char);

            value += (digit & 31) << shift;
            shift += 5;

            if (!(digit & 32)) {
                fields.push(value & 1 ? -(value >> 1) : value >> 1);
                value = 0;
                shift = 0;
            }
        }

        line += fields[2];
        return line;
    });
};

// A module of two statements, Python's lines 1 and 4, ten lines into its file.
const mapped = () => {
    const { module, map } = brycomp.compile(host, 'x = 1\n\n\ny = 2\n', {
        ...options,
        source: 'src/Card.py',
        lineOffset: 10,
        sourceContent: 'the source'
    });
    const lines = module.split('\n');

    return { map, lines, original: originalLines(map.mappings), at: (n) => lines.findIndex((one) => one.includes(`$B.set_lineno(frame, ${n})`)) };
};

test('a generated line maps to the Python line it came from, moved by what stands before the Python', () => {
    const { map, original, at } = mapped();

    expect(map).toMatchObject({ version: 3, sources: ['src/Card.py'], sourcesContent: ['the source'], names: [] });
    // Zero-based, as a map counts: Python's line 1 is the file's line 11, and
    // the line after the call is the same line.
    expect([original[at(1)], original[at(1) + 1], original[at(4)], original[at(4) + 1]]).toEqual([10, 10, 13, 13]);
});

test('a line before any Python line maps to nothing', () => {
    const { lines, original, at } = mapped();

    expect(original.slice(0, at(1))).toEqual(Array(at(1)).fill(null));
    expect(original).toHaveLength(lines.length);
});

// A class's statement is marked with its kind, `set_lineno(frame, 1,
// 'ClassDef')`, and its lines map to it as any other's: they mapped to nothing
// up to the next statement.
test("a class's lines map to its line, which Brython marks with the kind of statement", () => {
    const { module, map } = brycomp.compile(host, 'class Box:\n    size = 1\n', options);
    const lines = module.split('\n');
    const original = originalLines(map.mappings);
    const at = lines.findIndex((one) => one.includes("$B.set_lineno(frame, 1, 'ClassDef')"));

    expect(at).toBeGreaterThan(-1);
    expect([original[at], original[at + 1]]).toEqual([0, 0]);
});

// The marker's text in a Python string is data, and moves no line.
test("a string holding the marker's text maps to its own line", () => {
    const { module, map } = brycomp.compile(host, 'x = "$B.set_lineno(frame, 9000)"\ny = 2\n', options);
    const at = module.split('\n').findIndex((one) => one.includes('9000'));

    expect(originalLines(map.mappings)[at]).toBe(0);
});

// The block that lets a module read a builtin's name JavaScript gives it,
// `max`, follows the author's lines: it maps to nothing, where it was mapped
// past the end of the file, two lines out of two, and two of four moved by two.
test.for([
    [0, [0]],
    [2, [2]]
])("the lines added for a builtin's name JavaScript gives map to nothing, the file %i lines in", ([lineOffset, authored]) => {
    const { map } = brycomp.compile(host, 'result = max(2, 3)\n', { ...options, jsNames: ['max'], lineOffset });
    const mapped = originalLines(map.mappings).filter((one) => one !== null);

    expect([...new Set(mapped)]).toEqual(authored);
});

// A template's function follows the script in the Python compiled, and its
// lines map to the markup its expression is written on, as an error raised in
// it is placed: moved by the script's offset alone, an expression of line 13
// was sent to line 14.
test("a template function's lines map to the markup line of its expression", () => {
    const { module, map } = brycomp.compile(host, 'x = 1\n', {
        ...options,
        component: true,
        lineOffset: 1,
        defs: ['def __brycomp_expr_0():\n    return ("MARKED")'],
        defLines: [12],
        defColumns: [4]
    });
    const at = module.split('\n').findIndex((one) => one.includes('MARKED'));

    expect(originalLines(map.mappings)[at]).toBe(11);
});

// **The code Brython generated lives in a module of its own**, which imports
// its runtime from the host's bridge, under the names the host's runtime gives
// it, and runs the Python body inside the namespace it is handed: a Python
// exception comes out as the runtime makes it, said for the source. And the
// namespace the code opens is the one Brycomp names for the file, or the module
// Python imports it by.
//
// A host whose generated names share no scope with the author's, as a Vue
// component's do not, and one whose do, as a Svelte script's.
const plain = { name: 'host', bridge: 'host/bridge', runtime: { withNamespace: 'withNamespace', pyError: 'pyError' } };
const prefixed = { ...plain, runtime: { withNamespace: '__brycomp_withNamespace', pyError: '__brycomp_pyError' } };

const compiled = (host, named = null) => brycomp.compile(host, 'x = 1\n', { name: 'a', source: 'src/a.py', named });

test('the module imports its runtime from the bridge, under the names the host gives it', () => {
    const code = (host) => compiled(host).module.split('\n');

    expect(code(plain).slice(0, 5)).toEqual([
        'import { withNamespace, pyError } from "host/bridge";',
        '',
        `export function init(${NS}) {`,
        '  try {',
        `    return withNamespace("src/a_py", ${NS}, () => {`
    ]);
    expect(code(plain).slice(-3)).toEqual(['    });', '  } catch (err) { throw pyError(err,"src/a.py"); }', '}']);
    expect(code(prefixed)[0]).toBe('import { withNamespace as __brycomp_withNamespace, pyError as __brycomp_pyError } from "host/bridge";');
    // A path is written as a JavaScript string, a quote in it escaped.
    expect(compiled({ ...plain, bridge: "./O'Brien/bridge.mjs" }).module.split('\n')[0]).toBe(
        'import { withNamespace, pyError } from "./O\'Brien/bridge.mjs";'
    );
    expect(code(prefixed)[4]).toBe(`    return __brycomp_withNamespace("src/a_py", ${NS}, () => {`);
});

test('the namespace is the file, or the module Python imports it by', () => {
    expect(compiled(plain).namespace).toBe('src/a_py');
    expect(compiled(plain, 'shop-cart').namespace).toBe('shop_cart');
});

// A name an earlier import left for the file in the engine is not the file's
// when the compile names none, and is there again afterwards.
test('an unnamed module is named after its file, whatever name the engine held for it', () => {
    const $B = globalThis.__BRYTHON__;

    $B.url2name['src/a.py'] = 'earlier';
    try {
        expect([compiled(plain).namespace, $B.url2name['src/a.py']]).toEqual(['src/a_py', 'earlier']);
    } finally {
        delete $B.url2name['src/a.py'];
    }
});

// **A compile runs the common half in its order, the host's own syntax made
// Python before the translation** (`host.rewrite`): a host that writes `TWO`
// for `2` has it rewritten, told which names `importjs` binds, and a host with
// no syntax of its own has the text compiled as it is.
test("the host's rewrite runs before the translation, and a host with none leaves the text", () => {
    const told = [];
    const rewriting = {
        ...plain,
        rewrite: (text, { bound }) => {
            told.push([...bound]);
            return text.replace('TWO', '2');
        }
    };
    const options = { name: 'a', source: 'src/a.py', component: true };
    const compiled = brycomp.compile(rewriting, 'importjs { shuffle } from "lodash"\nx = TWO\n', options);

    expect(compiled.src).toBe('\nx = 2\n');
    expect(told).toEqual([['shuffle']]);
    expect(compiled.jsImported).toEqual(['shuffle']);
    expect(compiled.module).toContain(`return withNamespace("src/a_py", ${NS}, () => {`);
    expect(brycomp.compile(plain, 'x = TWO\n', options).src).toBe('x = TWO\n');
});

// **And the JavaScript is compiled from the words the host has it read**
// (`host.translate`), handed the tree the analysis read and the names
// JavaScript gives the module, while the analysis and the source stay the
// author's.
test("the host's translate gives the JavaScript its words, and leaves the analysis the author's", () => {
    const told = [];
    const translating = {
        ...plain,
        translate: (text, tree, names) => {
            told.push([tree.body.length, [...names]]);
            return text.replace('first', 'other');
        }
    };
    const options = { name: 'a', source: 'src/a.py', jsNames: ['shown'] };
    const compiled = brycomp.compile(translating, 'x = first\n', options);

    expect(told).toEqual([[1, ['shown']]]);
    expect(compiled.js).toContain("'other'");
    expect(compiled.js).not.toContain("'first'");
    expect(compiled.src).toBe('x = first\n');
    expect(compiled.root._ast.body[0].value.id).toBe('first');
});

// **The namespace a Python body runs in is a view of the accessors it inherits**:
// made from them through the host's runtime, flagged `$proxy` so that Brython
// reads a global through the prototype chain, and known to Python by its
// module's name. One a body may replace is declared so.
test('made from the accessors, flagged and named', () => {
    expect(brycomp.namespaceObject(host, { name: 'shop' })).toEqual([
        `const ${NS} = globalThis.Object.create(${brycomp.PROTO});`,
        `${NS}.$proxy = true;`,
        `${NS}.__name__ = "shop";`
    ]);
});

test('one a body may replace is a `let`', () => {
    expect(brycomp.namespaceObject(host, { name: 'shop', replaced: true })[0]).toBe(`let ${NS} = globalThis.Object.create(${brycomp.PROTO});`);
});

// **A name of the module is a cell the host makes one of its states, behind an
// accessor Brycomp writes**: the accessor reads the cell so that a change in place
// moves its readers, follows the cell itself for the rows of a template's loop,
// and writes through `track`, unless the write changes nothing.
test('the cell is the host\'s state, with the bump that moves its readers', () => {
    expect(brycomp.stateCell(host, 'count', '__ref_count')).toEqual([
        'const __ref_count = shallowRef(undefined);',
        'const __brycomp_bump_count = () => triggerRef(__ref_count);'
    ]);
});

test('the accessor reads and writes the cell as the host does, through track', () => {
    expect(brycomp.stateBinding(host, 'count', '__ref_count')).toBe(
        `bind(${brycomp.PROTO}, 'count', () => (SHAPING.on ? followOwn(__ref_count.value) : __ref_count.value), ` +
            `(${next}) => { const __brycomp_was = __brycomp_bump_count.held; try { const __brycomp_written = track(${next}, __brycomp_bump_count);` +
            ` if (!changesNothing(__brycomp_written, __brycomp_was)) __ref_count.value = __brycomp_written; }` +
            ` catch (__brycomp_refused) { track(__brycomp_was, __brycomp_bump_count); throw __brycomp_refused; } });`
    );
});

// A write the host refuses before it stores it leaves what the name's readers
// follow on the value the cell kept, where `track` had moved it onto the one
// refused; the host's own error reaches the writer.
test('a write the host refuses leaves the name followed as the cell holds it', () => {
    const line = brycomp.stateBinding(host, 'items', '__ref_items', { subs: '__brycomp_subs' });
    const refused = new Error('refused');
    const cell = {
        held: 'first',
        get value() {
            return this.held;
        },
        set value(given) {
            if (given === 'second') throw refused;
            this.held = given;
        }
    };
    const bump = { held: undefined };
    const subs = [];
    const track = (value, moved, list) => {
        moved.held = value;
        list.length = 0;
        list.push(value);
        return value;
    };
    const proto = {};
    const accessors = {};
    const bind = (target, name, get, set) => Object.assign(accessors, { get, set });

    new Function(brycomp.PROTO, '__ref_items', '__brycomp_bump_items', '__brycomp_subs', 'bind', 'SHAPING', 'followOwn', 'track', 'changesNothing', line)(
        proto, cell, bump, subs, bind, { on: false }, (one) => one, track, (one, other) => one === other
    );
    accessors.set('first');

    let error;

    try {
        accessors.set('second');
    } catch (caught) {
        error = caught;
    }

    expect([error, cell.value, bump.held, subs]).toEqual([refused, 'first', 'first', ['first']]);
});

// Told the name with the cell, on either branch, so a host reads the rows'
// cell as it reads the name: it was told the cell alone there.
test('the host reads the cell for the rows of a loop knowing the name, as it reads the name', () => {
    const told = [];
    const naming = { ...host, state: { ...host.state, value: (cell, name) => (told.push(name), `${cell}.value`) } };
    brycomp.stateBinding(naming, 'go', '__brycomp_fn_go');

    expect(told).toEqual(['go']);
});

test("an instance signs its containers onto its own list, and a function's accessor hands what it holds", () => {
    const line = brycomp.stateBinding(host, 'go', '__brycomp_fn_go', { subs: '__brycomp_subs', held: '__brycomp_fn_go' });

    expect(line).toContain(`track(${next}, __brycomp_bump_go, __brycomp_subs)`);
    expect(line.endsWith(' }, () => __brycomp_fn_go);')).toBe(true);
});

// A state the host makes its own copy of is tracked by the host's function,
// which gives what the name keeps of the value written: the cell holds that
// copy, and a refused write is put back through it.
test("a write keeps what the host's own track gives of the value", () => {
    const line = brycomp.stateBinding(host, 'rows', '__ref_rows', { track: 'ownTrack' });
    const cell = { value: undefined };
    const bump = { held: undefined };
    const ownTrack = (value, moved) => ((moved.held = Array.isArray(value) ? { copy: [...value] } : value), moved.held);
    const accessors = {};
    const bind = (target, name, get, set) => Object.assign(accessors, { get, set });

    new Function(brycomp.PROTO, '__ref_rows', '__brycomp_bump_rows', 'bind', 'SHAPING', 'followOwn', 'ownTrack', 'changesNothing', line)(
        {}, cell, bump, bind, { on: false }, (one) => one, ownTrack, (one, other) => one === other
    );
    accessors.set(['a']);

    expect([cell.value, bump.held === cell.value]).toEqual([{ copy: ['a'] }, true]);
    expect(line).toContain('catch (__brycomp_refused) { ownTrack(__brycomp_was, __brycomp_bump_rows); throw __brycomp_refused; }');
});

// And Python reads what the host's `read` gives of what the cell holds, on
// either branch, told the name's bump.
test("a read is what the host's own read gives of the cell", () => {
    const line = brycomp.stateBinding(host, 'rows', '__ref_rows', { read: 'ownRead' });
    const cell = { value: 'kept' };
    const bump = { held: 'kept' };
    const accessors = {};
    const bind = (target, name, get, set) => Object.assign(accessors, { get, set });
    const shaping = { on: false };

    new Function(brycomp.PROTO, '__ref_rows', '__brycomp_bump_rows', 'bind', 'SHAPING', 'followOwn', 'track', 'changesNothing', 'ownRead', line)(
        {}, cell, bump, bind, shaping, (one) => `followed ${one}`, (one) => one, (one, other) => one === other, (one, moved) => `${one} as read by ${moved === bump}`
    );
    const read = accessors.get();
    shaping.on = true;

    expect([read, accessors.get()]).toEqual(['kept as read by true', 'followed kept as read by true']);
});

// **A component's Python is its script, dedented, with the template's
// functions after it**, as the host hands them: the block an author indents
// inside the markup is taken back to column zero as Brython takes a `<script
// type="text/python">`, each function is joined as written, its dot plain
// Python's, and Brycomp says where each function lands, at the markup line and
// column it stands for.
const component = (text, more) => brycomp.compile(host, text, { name: 'Probe', source: 'src/Probe.svelte', component: true, ...more });

test('the script dedented, the functions after it as written, each where its markup stands', () => {
    const defs = ['def __brycomp_expr_0(row):\n    return __brycomp_text(row.name)', 'def __brycomp_expr_1():\n    return __brycomp_text(1)'];
    const { src, ranges, templateLine } = component('    x = 1\n\n    y = 2', { defs, defLines: [12, 14], defColumns: [4, 0], defTexts: ['row.name', '1'] });

    expect(src).toBe(
        'x = 1\n\ny = 2\n' +
            'def __brycomp_expr_0(row):\n    return __brycomp_text(row.name)\n\n' +
            'def __brycomp_expr_1():\n    return __brycomp_text(1)\n'
    );
    // Python lines 4 to 5 and 7 to 8, the markup's line 12, column 4, and 14,
    // and each expression as written.
    expect(ranges).toEqual([
        [4, 5, 12, 4, 'row.name'],
        [7, 8, 14, 0, '1']
    ]);
    expect(templateLine).toBe(4);
});

test('a script with no template functions is the script, dedented', () => {
    const { src, ranges, templateLine } = component('    x = 1');

    expect({ src, ranges, templateLine }).toEqual({ src: 'x = 1', ranges: [], templateLine: undefined });
});

// **What the host binds for a template's functions to call is read as a name
// the module binds** (`host.adapters`), off the namespace: a name nothing in
// the module binds was searched for at each call, through the function's own
// locals first.
test("a template's function reads the host's adapter off the namespace", () => {
    const defs = ['def __brycomp_expr_0(row):\n    return __brycomp_text(row["name"])'];
    const read = (more) => brycomp.compile({ ...host, ...more }, 'x = 1', { name: 'Probe', source: 'src/Probe.svelte', component: true, defs }).js;
    const namespace = 'locals_src_Probe_svelte';

    expect(read()).toContain(`$B.resolve_in_scopes('__brycomp_text', [${namespace}___brycomp_expr_0,${namespace},_b_]`);
    expect(read({ adapters: ['__brycomp_text'] })).toContain(`(${namespace}.__brycomp_text ?? $B.resolve_in_scopes('__brycomp_text', [${namespace}, _b_]))`);
    expect(read({ adapters: ['__brycomp_text'] })).not.toContain(`${namespace}___brycomp_expr_0,${namespace},_b_`);
    // And no compile after it reads one so.
    expect(read()).toContain(`$B.resolve_in_scopes('__brycomp_text', [${namespace}___brycomp_expr_0,${namespace},_b_]`);
});

// **A host whose template's dot reads a key rewrites its functions with
// `templateDots`** before it hands them over: each attribute read becomes a
// call to its `readAttr`, each write a binding makes a call to its
// `writeAttr`, under the names its runtime gives them, and no line is added.
// A script's own text is no template's, and the tool is not applied to it.
test("a host's template dot becomes its runtime's calls, under the names it gives them", () => {
    const named = (readAttr, writeAttr) => ({ ...host, runtime: { ...host.runtime, readAttr, writeAttr } });
    const read = 'def __brycomp_expr_0(row):\n    return __brycomp_text(row.name)';
    const write = 'def __brycomp_expr_set_0(value, row):\n    row.label = value';

    expect(brycomp.templateDots(named('__brycomp_getattr', '__brycomp_setattr'), read)).toBe('def __brycomp_expr_0(row):\n    return __brycomp_text(__brycomp_getattr(row, "name"))');
    expect(brycomp.templateDots(named('readAttr', 'writeAttr'), read)).toBe('def __brycomp_expr_0(row):\n    return __brycomp_text(readAttr(row, "name"))');
    // The value evaluated first, as Python evaluates `=`'s, then the object.
    expect(brycomp.templateDots(named('readAttr', 'writeAttr'), write)).toBe(
        'def __brycomp_expr_set_0(value, row):\n    (lambda __brycomp_given: writeAttr(row, "label", __brycomp_given))((value))'
    );
    // A dot over two lines keeps the second, so the next line stays its own.
    expect(brycomp.templateDots(named('readAttr', 'writeAttr'), 'def __brycomp_expr_0(row):\n    n = (row.\n         name)\n    return n')).toBe(
        'def __brycomp_expr_0(row):\n    n = (readAttr(row, "name"\n))\n    return n'
    );
    // A name the function binds of a helper's spelling would take its call:
    // a parameter, a lambda's, a comprehension's, a walrus.
    const reading = named('readAttr', 'writeAttr');

    for (const body of [
        '(lambda readAttr: row.name)(0)',
        '[row.name for readAttr in [0]]',
        '[(readAttr := 0), row.name]',
        '(lambda writeAttr: row.name)(0)'
    ]) {
        expect(() => brycomp.templateDots(reading, `def __brycomp_expr_0(row):\n    return ${body}`)).toThrow(/is the helper a template expression calls/);
    }
    expect(brycomp.templateDots(reading, 'def __brycomp_expr_0(row):\n    return (lambda other: row.name)(0)')).toBe(
        'def __brycomp_expr_0(row):\n    return (lambda other: readAttr(row, "name"))(0)'
    );
    // A dot in a comment is none.
    expect(brycomp.templateDots(named('readAttr', 'writeAttr'), 'def __brycomp_expr_0(row):\n    return (row. # see profile.name\n            name)')).toBe(
        'def __brycomp_expr_0(row):\n    return (readAttr(row, "name"\n))'
    );
    // A comment after a parenthesised target is left out of what closes it.
    expect(brycomp.templateDots(named('readAttr', 'writeAttr'), 'def __brycomp_expr_set_0(value, row):\n    (row.label\n     # kept\n    ) = value')).toBe(
        'def __brycomp_expr_set_0(value, row):\n    (lambda __brycomp_given: writeAttr((row), "label", __brycomp_given))(\n\n(value))'
    );
});

// A t-string is handed to the host's `templateText` with the text it was
// written with, each expression and a debug field's label as the source has
// them, its spaces and parentheses included, the `=` becoming the `!r` it
// stands for: rewritten, its `strings` and `.expression` showed the call.
test("a template's t-string is handed its runtime with the text it was written with", () => {
    const writing = { ...host, runtime: { ...host.runtime, readAttr: 'readAttr', writeAttr: 'writeAttr', templateText: 'templateText' } };
    const shown = (text) => brycomp.templateDots(writing, `def __brycomp_expr_0(row):\n    return ${text}`).split('\n')[1];

    expect(shown('t"{row.name=}"')).toBe('    return templateText(t"{readAttr(row, "name")!r}", ["row.name"], ["row.name="])');
    // Between triple quotes, and on a line after the first.
    expect(shown('t"""{x}"""')).toBe('    return templateText(t"""{x}""", ["x"], [""])');
    expect(shown('t"a {(row.name)!s:>3} b"')).toBe('    return templateText(t"a {(readAttr(row, "name"))!s:>3} b", ["(row.name)"], [""])');
    expect(shown('t"{ row.name = }"')).toBe('    return templateText(t"{ readAttr(row, "name") !r}", [" row.name "], [" row.name = "])');

    const lines = (text) => brycomp.templateDots(writing, `def __brycomp_expr_0(row):\n    return ${text}`).split('\n').slice(1).join('\n');

    expect(lines('t"""a\n{row.name}"""')).toBe('    return templateText(t"""a\n{readAttr(row, "name")}""", ["row.name"], [""])');
    expect(lines('f"""a\n{row.name}"""')).toBe('    return f"""a\n{readAttr(row, "name")}"""');
});

// The value written is one argument, all that stands after the `=`: one in
// parentheses of its own went before the object, `row(`, and a tuple handed
// the helper four arguments.
test('a write in a template hands its runtime the whole value, grouped or a tuple', () => {
    const writing = { ...host, runtime: { ...host.runtime, readAttr: 'readAttr', writeAttr: 'writeAttr' } };
    const set = (value) => brycomp.templateDots(writing, `def __brycomp_expr_set_0(value, row):\n    row.label = ${value}`).split('\n').slice(1).join('\n');

    const written = (value) => `    (lambda __brycomp_given: writeAttr(row, "label", __brycomp_given))(${value})`;

    expect(set('(value)')).toBe(written('((value))'));
    expect(set('(value + 1)')).toBe(written('((value + 1))'));
    expect(set('value, 1')).toBe(written('(value, 1)'));
    expect(set('(\n        value\n    )')).toBe(written('((\n        value\n    ))'));
});

// A comprehension's target reads what it assigns into, `row` in
// `for row["flag"] in …`, at each step: a parameter handed late is read there
// as everywhere, a call, where the target was left as it was and assigned
// into the function standing for the row.
test("a parameter handed late is called where a comprehension's target reads it", () => {
    const late = 'def __brycomp_expr_0_late(row):\n    return (0 for row["flag"] in [1, 2])';

    expect(brycomp.templateDots(host, late)).toBe('def __brycomp_expr_0_late(row):\n    return (0 for row()["flag"] in [1, 2])');
});

// In an `async def` as in a `def`: read as written, the parameter stayed the
// function standing for it, and `row + 1` added an int to it. One not handed
// late is read as it is.
test.for([
    ['async def __brycomp_expr_0_late(row):\n    return row + 1', 'async def __brycomp_expr_0_late(row):\n    return row() + 1'],
    ['async def __brycomp_expr_0_late(row):\n    return row.title', 'async def __brycomp_expr_0_late(row):\n    return readAttr(row(), "title")'],
    ['async def __brycomp_expr_0(row):\n    return row + 1', 'async def __brycomp_expr_0(row):\n    return row + 1']
])('an asynchronous template function reads its parameters as handed: %s', ([written, expected]) => {
    const reading = { ...host, runtime: { ...host.runtime, readAttr: 'readAttr', writeAttr: 'writeAttr' } };

    expect(brycomp.templateDots(reading, written)).toBe(expected);
});

// And every target of a comprehension is local to all of it: a lambda in an
// earlier clause that reads one captures the comprehension's, which it was
// made to call, an int. The first iterable is read outside, where the
// parameter is the one handed late, and so is a lambda written there.
test.for([
    ['[row, [capture() for _ in [0] for capture in [lambda: row] for row in [1, 2]]]', '[row(), [capture() for _ in [0] for capture in [lambda: row] for row in [1, 2]]]'],
    ['[row, [capture() for _ in [0] for capture in [lambda: row] for row, _ in [(1, 0), (2, 0)]]]', '[row(), [capture() for _ in [0] for capture in [lambda: row] for row, _ in [(1, 0), (2, 0)]]]'],
    ['[row, list(capture() for _ in [0] for capture in [lambda: row] for row in [1, 2])]', '[row(), list(capture() for _ in [0] for capture in [lambda: row] for row in [1, 2])]'],
    ['[row, [capture() for capture in [lambda: row] for row in [1, 2]]]', '[row(), [capture() for capture in [lambda: row()] for row in [1, 2]]]'],
    ['[row, [row for row in [row]]]', '[row(), [row for row in [row()]]]'],
    ['[row, [capture() for row in [1, 2] for capture in [lambda: row]]]', '[row(), [capture() for row in [1, 2] for capture in [lambda: row]]]']
])('a parameter handed late is the comprehension’s own where it binds it: %s', ([body, expected]) => {
    expect(brycomp.templateDots(host, `def __brycomp_expr_0_late(row):\n    return ${body}`)).toBe(`def __brycomp_expr_0_late(row):\n    return ${expected}`);
});
