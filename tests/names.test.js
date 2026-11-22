// @vitest-environment node
//
// What a name of the module may be, and what a source may import: a word
// JavaScript reserves, a name a JavaScript import brings, a word the host
// reserves, and a module that does not ship.
import { test, expect } from 'vitest';
import * as brycomp from '../src/brycomp.js';

const host = {
    name: 'host',
    runtime: { bind: 'bind', jsCall: 'jsCall', readOnlyImport: 'readOnly' },
    reserved: {
        words: [
            { name: 'derived', component: false },
            { name: 'export', component: true }
        ],
        said: 'Its helpers may still be shadowed.'
    },
    instead: { json: '`load(text)` reads JSON' },
    pathOption: 'dirs'
};
const source = 'src/a.py';
const P = brycomp.PROTO;

// **What the generated module cannot bind is refused on the line that binds
// it**, under the host's name: a word JavaScript reserves, with the trailing
// underscore Python's convention gives it, and a name a JavaScript import
// brings, which Python reads and never binds, at the module's top level or in
// a function that declares it `global`, and not where a function binds a name
// of its own.
test('a word JavaScript reserves is refused on its line, with the name Python writes instead', () => {
    expect(() => brycomp.refuseReserved(host, ['default'], source, new Map([['default', 2]]), 3)).toThrow(
        /^host — `default` is a reserved word in JavaScript, and the generated module cannot bind one \(src\/a\.py:5\)\. .* `default_`\.$/
    );
    expect(() => brycomp.refuseReserved(host, [], source, new Map())).not.toThrow();
});

// The module imports `navigate` from JavaScript on its first line, ten lines
// into its file.
const bound = (src) => () => brycomp.compile(host, `__js__ = {"router": ["navigate"]}\n${src}`, { name: 'a', source, lineOffset: 10 });

test("a JavaScript import bound by the module, or by a function's `global`, is refused on its line", () => {
    expect(bound('navigate = 2\n')).toThrow(/^host — `navigate` is a JavaScript import, which Python reads and never binds, .* \(src\/a\.py:12\)/);
    expect(bound('def go():\n    global navigate\n    navigate = 1\n')).toThrow(/\(src\/a\.py:14\)/);
});

test("a function's own name of that spelling binds nothing of the module's", () => {
    expect(bound('def go():\n    navigate = 1\n    return navigate\n')).not.toThrow();
});

// A key written twice holds its last list, as the dict Python builds does: the
// first list's names, imported as well, were refused by a module that no longer
// exports them.
test('a module named twice in `__js__` imports the last list alone', () => {
    const { jsImports } = brycomp.compile(host, '__js__ = {"./v.js": ["removed"], "./w.js": ["w"], "./v.js": ["kept"]}\n', { name: 'a', source });

    expect(jsImports.map((one) => [one.from, one.entries.map((entry) => entry.name)])).toEqual([
        ['./v.js', ['kept']],
        ['./w.js', ['w']]
    ]);
});

// The module's path is the string Python reads, which the engine's tree holds
// escaped for JavaScript.
test('a path of `__js__` is the string Python reads, a quote and a backslash in it', () => {
    const { jsImports } = brycomp.compile(host, String.raw`__js__ = {"./O'Brien.js": ["a"], "./back\\slash.js": ["b"]}` + '\n', { name: 'a', source });

    expect(jsImports.map((one) => one.from)).toEqual(["./O'Brien.js", './back\\slash.js']);
});

// **The directive is a dict assigned at the top of the module, and nothing else
// touches the module's `__js__`**: a binding in a branch, a loop, a
// destructuring, a second target, an import, a `def`, a function's `global`, a
// write to the dict or to one of its lists, or a read that hands it on, is
// refused on its line. A function's own `__js__` is its own.
test.each([
    ['in a branch', 'if True:\n    __js__ = {"./a.js": ["kept"]}\n', 2],
    ['destructured', '[__js__] = [{"./a.js": ["kept"]}]\n', 1],
    ['by a global', 'def setup():\n    global __js__\n    __js__ = {"./a.js": ["kept"]}\n', 3],
    ['with a second target', '__js__ = alias = {"./a.js": ["kept"]}\n', 1],
    ['by a loop', 'for __js__ in [{}]:\n    pass\n', 1],
    ['by an import', 'import json as __js__\n', 1],
    ['by a def', 'def __js__():\n    pass\n', 1],
    ['handed on', '__js__ = {"./a.js": ["kept"]}\nalias = __js__\n', 2],
    ['handed on in a union, which holds its lists', '__js__ = {"./a.js": ["kept"]}\nalias = __js__ | {}\n', 2],
    ['handed on in a union the other way', '__js__ = {"./a.js": ["kept"]}\nalias = {} | __js__\n', 2],
    ['through one of its lists', '__js__ = {"./a.js": ["kept"]}\n__js__["./a.js"].append("more")\n', 2],
    ['deleted', '__js__ = {"./a.js": ["kept"]}\ndel __js__\n', 2]
])('`__js__` written %s is refused on its line', (form, src, line) => {
    expect(() => brycomp.compile(host, src, { name: 'a', source })).toThrow(new RegExp(`\`__js__\` is set by assigning it a dict .* \\(src/a\\.py:${line}\\)`));
});

// An entry that is no string names no import: it was left out, where the
// module still read it in its list.
test('an entry of `__js__` that is no string is refused, named, on the line of the directive', () => {
    for (const [entries, shown] of [
        ['["first", 27]', '`27`, an `int`'],
        ['[False]', '`False`, a `bool`']
    ]) {
        expect(() => brycomp.compile(host, `__js__ = {"./numbers.mjs": ${entries}}\n`, { name: 'a', source })).toThrow(
            `\`__js__\` lists ${shown}, for \`./numbers.mjs\`, and each entry is the name of an import, a string (src/a.py:1)`
        );
    }
});

// A builtin's name the directive imports is JavaScript's function, which may
// change what it is handed: `list(__js__)` hands the dict on.
test('`__js__` handed to a JavaScript import spelled like a builtin is refused, and to the builtin is read', () => {
    expect(() => brycomp.compile(host, '__js__ = {"./api.mjs": ["list", "kept"]}\nlist(__js__)\n', { name: 'a', source })).toThrow(
        /`__js__` is set by assigning it a dict .* \(src\/a\.py:2\)/
    );
    expect(() => brycomp.compile(host, '__js__ = {"./api.mjs": ["kept"]}\nlist(__js__)\n', { name: 'a', source })).not.toThrow();
    expect(() => brycomp.compile(host, '__js__ = {"./api.mjs": ["kept"]}\nlist(__js__)\n', { name: 'a', source, jsNames: ['list'] })).toThrow(
        /`__js__` is set by assigning it a dict/
    );
});

// Its lists hold strings alone: one of them, a copy of a list, the items an
// unpacking takes, handed on, change nothing of it.
test('a string of `__js__`, a copy of a list of it, and an unpacking of one are handed on', () => {
    const reads = ['x = __js__["./a.js"][0]', 'x = __js__["./a.js"][:]', 'first, = __js__["./a.js"]', 'first, *rest = __js__["./a.js"]', 'key, = __js__', 'x = ", ".join(__js__["./a.js"])'];

    for (const read of reads) {
        expect(() => brycomp.compile(host, `__js__ = {"./a.js": ["kept"]}\n${read}\n`, { name: 'a', source })).not.toThrow();
    }
    expect(() => brycomp.compile(host, '__js__ = {"./a.js": ["kept"]}\nx, = [__js__["./a.js"]]\n', { name: 'a', source })).toThrow(
        /`__js__` is set by assigning it a dict .* \(src\/a\.py:2\)/
    );
});

// A method that only reads hands on strings at most: a copy of a list, its
// count, the keys of the dict. One that hands a list on does not.
test('a method of `__js__` that only reads is a read, one that hands a list on is refused', () => {
    for (const read of ['x = __js__["./a.js"].copy()', 'n = __js__["./a.js"].index("kept")', 'keys = __js__.keys()', 'n = __js__.__len__()']) {
        expect(() => brycomp.compile(host, `__js__ = {"./a.js": ["kept"]}\n${read}\n`, { name: 'a', source })).not.toThrow();
    }
    for (const handed of ['x = __js__.get("./a.js")', 'x = __js__.values()', 'x = __js__.copy()', 'x = __js__.__getitem__("./a.js")']) {
        expect(() => brycomp.compile(host, `__js__ = {"./a.js": ["kept"]}\n${handed}\n`, { name: 'a', source })).toThrow(
            /`__js__` is set by assigning it a dict .* \(src\/a\.py:2\)/
        );
    }
});

test("`__js__` assigned at the top of the module is read, the last one counting, and a function's own is its own", () => {
    const src = '__js__ = {"./a.js": ["gone"]}\n__js__ = {"./a.js": ["kept"]}\nn = len(__js__["./a.js"])\n\ndef f():\n    __js__ = 1\n    return __js__\n';

    expect(brycomp.compile(host, src, { name: 'a', source }).jsImports.flatMap((one) => one.entries.map((entry) => entry.name))).toEqual(['kept']);
});

// **A name JavaScript gives the module is Python's spelling of it, to every
// analysis that asks**: `ｏｐｅｎ` is `open`, called as the import, and bound as
// one is refused.
test('a JavaScript name is read in Python spelling, by the refusals as by the translation', () => {
    expect(() => brycomp.compile(host, 'observed = open("value")\n', { name: 'a', source, jsNames: ['ｏｐｅｎ'] })).not.toThrow();
    expect(() => brycomp.compile(host, 'observed = help("value")\n', { name: 'a', source, jsNames: ['ｈｅｌｐ'] })).not.toThrow();
    expect(bound('ｎａｖｉｇａｔｅ = 2\n')).toThrow(/`navigate` is a JavaScript import/);
});

// A name that starts with the keyword is a name, in a module and a component.
test('`importjsé` is a name, not the keyword', () => {
    const src = 'importjsé = 7\nobserved = importjsé\n';

    expect(() => brycomp.compile(host, src, { name: 'a', source })).not.toThrow();
    expect(() => brycomp.compile(host, src, { name: 'a', source, component: true })).not.toThrow();
});

// A walrus in a lambda binds the lambda's own name, its comprehension's too,
// which no value of the template's stands for.
test("a walrus in a lambda reads no name of the template's", () => {
    expect(['(lambda: (x := 1))()', '(lambda: ((x := 1), x))()', '(lambda: ([(x := y) for y in [1]], x))()'].map(brycomp.freeNames)).toEqual([[], [], []]);
    expect([brycomp.freeNames('(lambda y=x: y)()'), brycomp.freeNames('(lambda: (lambda: (x := 1)) and x)()')]).toEqual([['x'], ['x']]);
});

// **A name JavaScript gives the module is published to Python under the name
// Python reads**, on the namespace's accessors through the host's runtime:
// read afresh at every access, an import read-only, as JavaScript holds it. A
// name Python declares itself wins, each is published once, and two names
// Python reads as one are refused, under the host's name.
test('an import read-only, a name of the JavaScript beside the module read and written', () => {
    const lines = brycomp.jsNameBindings(host, { jsImported: ['navigate'], declared: ['total'], source }, ['total', 'amount', 'navigate']);

    expect(lines).toEqual([
        `bind(${P}, 'navigate', () => jsCall(navigate), () => readOnly("navigate", "src/a.py"));`,
        `bind(${P}, 'amount', () => jsCall(amount));`
    ]);
});

test('under the name Python reads', () => {
    expect(brycomp.jsNameBindings(host, { jsImported: [], declared: [], source: 'a.py' }, ['ﬁeld'])).toEqual([`bind(${P}, 'field', () => jsCall(ﬁeld));`]);
});

// A name of the JavaScript beside the module read as the host reads one: in a
// scope the host fills with names of its own, the bare name could be one.
test('a name of the JavaScript beside the module is read as the host reads one', () => {
    const reading = { ...host, moduleName: (n) => `module[${JSON.stringify(n)}]` };

    expect(brycomp.jsNameBindings(reading, { jsImported: ['navigate'], declared: [], source }, ['amount', 'navigate'])).toEqual([
        `bind(${P}, 'navigate', () => jsCall(navigate), () => readOnly("navigate", "src/a.py"));`,
        `bind(${P}, 'amount', () => jsCall(module["amount"]));`
    ]);
});

// **An import named like one of the framework's own words is held under
// another variable** (`host.runes`), the one its compiler leaves alone, and
// published to Python under its own name: Svelte reads `$effect` as a store
// once the module binds `effect`. A name of the JavaScript beside the module
// is the author's own and keeps its name.
test("an import named like one of the framework's words is imported under another variable, read by Python under its own", () => {
    const runes = { ...host, runes: ['effect', 'state'] };

    expect(brycomp.jsImportLine(runes, { from: './x.js', kind: 'named', entries: [{ name: 'effect', local: 'effect' }, { name: 'go', local: 'go' }] })).toBe(
        'import { effect as __brycomp_import_effect, go } from "./x.js";'
    );
    expect(brycomp.jsImportLine(runes, { from: './x.js', kind: 'default', entries: [{ name: 'default', local: 'state' }] })).toBe('import __brycomp_import_state from "./x.js";');
    expect(brycomp.jsNameBindings(runes, { jsImported: ['effect'], declared: [], source }, ['state'])).toEqual([
        `bind(${P}, 'effect', () => jsCall(__brycomp_import_effect), () => readOnly("effect", "src/a.py"));`,
        `bind(${P}, 'state', () => jsCall(state));`
    ]);
});

test('without the member, every import keeps its name', () => {
    expect(brycomp.jsImportLine(host, { from: './x.js', kind: 'named', entries: [{ name: 'effect', local: 'effect' }] })).toBe('import { effect } from "./x.js";');
});

test('two names Python reads as one are refused', () => {
    expect(() => brycomp.jsNameBindings(host, { jsImported: [], declared: [], source: 'a.py' }, ['field', 'ﬁeld'])).toThrow(
        /^host — `field` and `ﬁeld` are two JavaScript names Python reads as one, `field` \(a\.py\)/
    );
});

// **A word the host reserves is refused where the author takes it**, under the
// host's name, on the line the name was bound, and ends on what the host says:
// a component's word only in a component, and any other everywhere. A word the
// host does not reserve is the author's.
const lines = new Map([['derived', 3]]);

const refusal = (declared, component) => {
    try {
        brycomp.refuseHostWords(host, declared, component, source, lines, 10);
    } catch (error) {
        return error;
    }

    return null;
};

test('a reserved word is refused on its line, under the host name, ending on what the host says', () => {
    const error = refusal(['total', 'derived'], false);

    expect(error.message).toBe("host — `derived` is one of Host's own words and cannot be redefined (src/a.py:13). Its helpers may still be shadowed.");
    expect(error.start).toEqual({ line: 13, column: 0 });
});

test("a component's word is free in a module, and refused in a component, said with the file when no line is known", () => {
    expect(refusal(['export'], false)).toBe(null);
    expect(refusal(['export'], true).message).toMatch(/^host — `export` is one of Host's own words and cannot be redefined \(src\/a\.py\)\./);
});

test("a word the host does not reserve is the author's", () => {
    expect(refusal(['effect', 'total'], true)).toBe(null);
});

// **A module that does not ship is refused on the line that imports it**,
// under the host's name, with what the host says stands in for it, and a
// directory, which is no package, with the option the host also finds modules
// on. A module the runtime holds, or a file of the project, is imported as
// written.
const missing = (module, resolves = () => undefined) => () =>
    brycomp.compile(host, `x = 1\nimport ${module}\n`, { name: 'a', source, lineOffset: 10, resolves });

test('a module that does not ship is refused on its line, with what the host says stands in for it', () => {
    expect(missing('json')).toThrow(
        /^host — `json` is not a module a component can import: Python's standard library does not ship, .*; `load\(text\)` reads JSON \(src\/a\.py:12\)$/
    );
    expect(missing('csv')).toThrow(/the project's own `\.py` files do \(src\/a\.py:12\)$/);
    expect(missing('shop.cart', () => 'package')).toThrow(/on `dirs`, not through a package; .* add `shop` to `dirs` and import/);
    expect(missing('browser')).not.toThrow();
    expect(missing('cart', () => 'file')).not.toThrow();
});

// A reduction asked of an instance of a class a module beside it defines is
// that class's own, `__reduce__` or `__reduce_ex__`, read by its name or off
// the module: refused, the call compiled only once moved into the class's
// module. `object`'s still builds its answer with `copyreg`.
test.for([
    'from records import Record\nresult = Record(5).__reduce__()',
    'from records import Record\nresult = Record(5).__reduce_ex__(2)',
    'import records\nresult = records.Record(5).__reduce__()'
])('a reduction of an instance of a class imported from a module beside it compiles: %s', (written) => {
    expect(() => brycomp.compile(host, `${written}\n`, { name: 'a', source, resolves: () => 'file' })).not.toThrow();
});

test("object's reduction is still refused", () => {
    expect(() => brycomp.compile(host, 'result = object().__reduce__()\n', { name: 'a', source })).toThrow(/`__reduce__\(\)` builds its answer with `copyreg`/);
});

// Nor is an instance of a class of the module that may be another object, or
// hold its own methods: one its `__new__` hands back, its decorator puts in its
// place, its `__init__` gives the method to, or its `__getattribute__` finds it
// for. Refused as one with `object`'s, it was another's own.
const RECORD = 'class Record:\n    def __reduce__(self):\n        return (Record, (42,))\n';

test.for([
    ['__new__', 'class Proxy:\n    def __new__(cls): return Record()\n'],
    ['a decorator', 'def select(cls): return Record\n@select\nclass Proxy: pass\n'],
    ['__init__', 'class Proxy:\n    def __init__(self):\n        self.__reduce__ = lambda: (Record, (42,))\n'],
    ['__getattribute__', 'class Proxy:\n    def __getattribute__(self, name):\n        return lambda: (Record, (42,))\n']
])('a class whose instance may hold its own reduction, by %s, compiles', ([, proxy]) => {
    expect(() => brycomp.compile(host, `${RECORD}${proxy}result = Proxy().__reduce__()[1][0]\n`, { name: 'a', source })).not.toThrow();
});

// What the host says stands in is read among its own names: a module named like
// a property of `Object.prototype` got the function the prototype holds there,
// `; function Object() { [native code] }`, at the end of its refusal.
test('a missing module named like a property of Object.prototype is refused as any other', () => {
    for (const module of ['constructor', 'toString', 'hasOwnProperty']) {
        expect(missing(module)).toThrow(/the project's own `\.py` files do \(src\/a\.py:12\)$/);
    }
});
