// The names of Unicode characters, which a `\N{BULLET}` escape is read by. The
// engine fetches them beside brython.js, by a request that Node does not have;
// under Node they are read off Bryvend, which ships them, once, when an escape
// first asks. A browser keeps the engine's request.
const $B = globalThis.__BRYTHON__;
const fs = globalThis.process?.getBuiltinModule?.('node:fs');

if (fs && $B.unicodedb === undefined && typeof XMLHttpRequest === 'undefined') {
    const keep = (value) => Object.defineProperty($B, 'unicodedb', { value, writable: true, configurable: true });

    Object.defineProperty($B, 'unicodedb', {
        configurable: true,
        get() {
            const path = new URL(import.meta.resolve('bryvend/unicode.txt'));
            let names;

            try {
                names = fs.readFileSync(path, 'utf8');
            } catch {
                // no table: the engine refuses the escape at its line
            }

            keep(names);
            return names;
        },
        set: keep
    });
}
