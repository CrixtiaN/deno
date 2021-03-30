// Copyright 2018-2021 the Deno authors. All rights reserved. MIT license.
import { assert } from "../_util/assert.ts";
function get(obj, key) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
        return obj[key];
    }
}
function getForce(obj, key) {
    const v = get(obj, key);
    assert(v != null);
    return v;
}
function isNumber(x) {
    if (typeof x === "number") return true;
    if (/^0x[0-9a-f]+$/i.test(String(x))) return true;
    return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(e[-+]?\d+)?$/.test(String(x));
}
function hasKey(obj, keys) {
    let o = obj;
    keys.slice(0, -1).forEach((key)=>{
        o = get(o, key) ?? {
        };
    });
    const key = keys[keys.length - 1];
    return key in o;
}
/** Take a set of command line arguments, with an optional set of options, and
 * return an object representation of those argument.
 *
 *      const parsedArgs = parse(Deno.args);
 */ export function parse(args, { "--": doubleDash = false , alias ={
} , boolean =false , default: defaults = {
} , stopEarly =false , string =[] , unknown =(i)=>i
  } = {
}) {
    const flags = {
        bools: {
        },
        strings: {
        },
        unknownFn: unknown,
        allBools: false
    };
    if (boolean !== undefined) {
        if (typeof boolean === "boolean") {
            flags.allBools = !!boolean;
        } else {
            const booleanArgs = typeof boolean === "string" ? [
                boolean
            ] : boolean;
            for (const key of booleanArgs.filter(Boolean)){
                flags.bools[key] = true;
            }
        }
    }
    const aliases = {
    };
    if (alias !== undefined) {
        for(const key in alias){
            const val = getForce(alias, key);
            if (typeof val === "string") {
                aliases[key] = [
                    val
                ];
            } else {
                aliases[key] = val;
            }
            for (const alias of getForce(aliases, key)){
                aliases[alias] = [
                    key
                ].concat(aliases[key].filter((y)=>alias !== y
                ));
            }
        }
    }
    if (string !== undefined) {
        const stringArgs = typeof string === "string" ? [
            string
        ] : string;
        for (const key of stringArgs.filter(Boolean)){
            flags.strings[key] = true;
            const alias = get(aliases, key);
            if (alias) {
                for (const al of alias){
                    flags.strings[al] = true;
                }
            }
        }
    }
    const argv = {
        _: []
    };
    function argDefined(key, arg) {
        return flags.allBools && /^--[^=]+$/.test(arg) || get(flags.bools, key) || !!get(flags.strings, key) || !!get(aliases, key);
    }
    function setKey(obj, keys, value) {
        let o = obj;
        keys.slice(0, -1).forEach(function(key) {
            if (get(o, key) === undefined) {
                o[key] = {
                };
            }
            o = get(o, key);
        });
        const key = keys[keys.length - 1];
        if (get(o, key) === undefined || get(flags.bools, key) || typeof get(o, key) === "boolean") {
            o[key] = value;
        } else if (Array.isArray(get(o, key))) {
            o[key].push(value);
        } else {
            o[key] = [
                get(o, key),
                value
            ];
        }
    }
    function setArg(key, val, arg = undefined) {
        if (arg && flags.unknownFn && !argDefined(key, arg)) {
            if (flags.unknownFn(arg, key, val) === false) return;
        }
        const value = !get(flags.strings, key) && isNumber(val) ? Number(val) : val;
        setKey(argv, key.split("."), value);
        const alias = get(aliases, key);
        if (alias) {
            for (const x of alias){
                setKey(argv, x.split("."), value);
            }
        }
    }
    function aliasIsBoolean(key) {
        return getForce(aliases, key).some((x)=>typeof get(flags.bools, x) === "boolean"
        );
    }
    for (const key of Object.keys(flags.bools)){
        setArg(key, defaults[key] === undefined ? false : defaults[key]);
    }
    let notFlags = [];
    // all args after "--" are not parsed
    if (args.includes("--")) {
        notFlags = args.slice(args.indexOf("--") + 1);
        args = args.slice(0, args.indexOf("--"));
    }
    for(let i = 0; i < args.length; i++){
        const arg = args[i];
        if (/^--.+=/.test(arg)) {
            const m = arg.match(/^--([^=]+)=(.*)$/s);
            assert(m != null);
            const [, key, value] = m;
            if (flags.bools[key]) {
                const booleanValue = value !== "false";
                setArg(key, booleanValue, arg);
            } else {
                setArg(key, value, arg);
            }
        } else if (/^--no-.+/.test(arg)) {
            const m = arg.match(/^--no-(.+)/);
            assert(m != null);
            setArg(m[1], false, arg);
        } else if (/^--.+/.test(arg)) {
            const m = arg.match(/^--(.+)/);
            assert(m != null);
            const [, key] = m;
            const next = args[i + 1];
            if (next !== undefined && !/^-/.test(next) && !get(flags.bools, key) && !flags.allBools && (get(aliases, key) ? !aliasIsBoolean(key) : true)) {
                setArg(key, next, arg);
                i++;
            } else if (/^(true|false)$/.test(next)) {
                setArg(key, next === "true", arg);
                i++;
            } else {
                setArg(key, get(flags.strings, key) ? "" : true, arg);
            }
        } else if (/^-[^-]+/.test(arg)) {
            const letters = arg.slice(1, -1).split("");
            let broken = false;
            for(let j = 0; j < letters.length; j++){
                const next = arg.slice(j + 2);
                if (next === "-") {
                    setArg(letters[j], next, arg);
                    continue;
                }
                if (/[A-Za-z]/.test(letters[j]) && /=/.test(next)) {
                    setArg(letters[j], next.split(/=(.+)/)[1], arg);
                    broken = true;
                    break;
                }
                if (/[A-Za-z]/.test(letters[j]) && /-?\d+(\.\d*)?(e-?\d+)?$/.test(next)) {
                    setArg(letters[j], next, arg);
                    broken = true;
                    break;
                }
                if (letters[j + 1] && letters[j + 1].match(/\W/)) {
                    setArg(letters[j], arg.slice(j + 2), arg);
                    broken = true;
                    break;
                } else {
                    setArg(letters[j], get(flags.strings, letters[j]) ? "" : true, arg);
                }
            }
            const [key] = arg.slice(-1);
            if (!broken && key !== "-") {
                if (args[i + 1] && !/^(-|--)[^-]/.test(args[i + 1]) && !get(flags.bools, key) && (get(aliases, key) ? !aliasIsBoolean(key) : true)) {
                    setArg(key, args[i + 1], arg);
                    i++;
                } else if (args[i + 1] && /^(true|false)$/.test(args[i + 1])) {
                    setArg(key, args[i + 1] === "true", arg);
                    i++;
                } else {
                    setArg(key, get(flags.strings, key) ? "" : true, arg);
                }
            }
        } else {
            if (!flags.unknownFn || flags.unknownFn(arg) !== false) {
                argv._.push(flags.strings["_"] ?? !isNumber(arg) ? arg : Number(arg));
            }
            if (stopEarly) {
                argv._.push(...args.slice(i + 1));
                break;
            }
        }
    }
    for (const key of Object.keys(defaults)){
        if (!hasKey(argv, key.split("."))) {
            setKey(argv, key.split("."), defaults[key]);
            if (aliases[key]) {
                for (const x of aliases[key]){
                    setKey(argv, x.split("."), defaults[key]);
                }
            }
        }
    }
    if (doubleDash) {
        argv["--"] = [];
        for (const key of notFlags){
            argv["--"].push(key);
        }
    } else {
        for (const key of notFlags){
            argv._.push(key);
        }
    }
    return argv;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIjxodHRwczovL2Rlbm8ubGFuZC9zdGRAMC45MC4wL2ZsYWdzL21vZC50cz4iXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyMSB0aGUgRGVubyBhdXRob3JzLiBBbGwgcmlnaHRzIHJlc2VydmVkLiBNSVQgbGljZW5zZS5cblxuaW1wb3J0IHsgYXNzZXJ0IH0gZnJvbSBcIi4uL191dGlsL2Fzc2VydC50c1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFyZ3Mge1xuICAvKiogQ29udGFpbnMgYWxsIHRoZSBhcmd1bWVudHMgdGhhdCBkaWRuJ3QgaGF2ZSBhbiBvcHRpb24gYXNzb2NpYXRlZCB3aXRoXG4gICAqIHRoZW0uICovXG4gIF86IEFycmF5PHN0cmluZyB8IG51bWJlcj47XG4gIC8vIGRlbm8tbGludC1pZ25vcmUgbm8tZXhwbGljaXQtYW55XG4gIFtrZXk6IHN0cmluZ106IGFueTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcmdQYXJzaW5nT3B0aW9ucyB7XG4gIC8qKiBXaGVuIGB0cnVlYCwgcG9wdWxhdGUgdGhlIHJlc3VsdCBgX2Agd2l0aCBldmVyeXRoaW5nIGJlZm9yZSB0aGUgYC0tYCBhbmRcbiAgICogdGhlIHJlc3VsdCBgWyctLSddYCB3aXRoIGV2ZXJ5dGhpbmcgYWZ0ZXIgdGhlIGAtLWAuIEhlcmUncyBhbiBleGFtcGxlOlxuICAgKlxuICAgKiAgICAgIC8vICQgZGVubyBydW4gZXhhbXBsZS50cyAtLSBhIGFyZzFcbiAgICogICAgICBpbXBvcnQgeyBwYXJzZSB9IGZyb20gXCJodHRwczovL2Rlbm8ubGFuZC9zdGQvZmxhZ3MvbW9kLnRzXCI7XG4gICAqICAgICAgY29uc29sZS5kaXIocGFyc2UoRGVuby5hcmdzLCB7IFwiLS1cIjogZmFsc2UgfSkpO1xuICAgKiAgICAgIC8vIG91dHB1dDogeyBfOiBbIFwiYVwiLCBcImFyZzFcIiBdIH1cbiAgICogICAgICBjb25zb2xlLmRpcihwYXJzZShEZW5vLmFyZ3MsIHsgXCItLVwiOiB0cnVlIH0pKTtcbiAgICogICAgICAvLyBvdXRwdXQ6IHsgXzogW10sIC0tOiBbIFwiYVwiLCBcImFyZzFcIiBdIH1cbiAgICpcbiAgICogRGVmYXVsdHMgdG8gYGZhbHNlYC5cbiAgICovXG4gIFwiLS1cIj86IGJvb2xlYW47XG5cbiAgLyoqIEFuIG9iamVjdCBtYXBwaW5nIHN0cmluZyBuYW1lcyB0byBzdHJpbmdzIG9yIGFycmF5cyBvZiBzdHJpbmcgYXJndW1lbnRcbiAgICogbmFtZXMgdG8gdXNlIGFzIGFsaWFzZXMgKi9cbiAgYWxpYXM/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBzdHJpbmdbXT47XG5cbiAgLyoqIEEgYm9vbGVhbiwgc3RyaW5nIG9yIGFycmF5IG9mIHN0cmluZ3MgdG8gYWx3YXlzIHRyZWF0IGFzIGJvb2xlYW5zLiBJZlxuICAgKiBgdHJ1ZWAgd2lsbCB0cmVhdCBhbGwgZG91YmxlIGh5cGhlbmF0ZWQgYXJndW1lbnRzIHdpdGhvdXQgZXF1YWwgc2lnbnMgYXNcbiAgICogYGJvb2xlYW5gIChlLmcuIGFmZmVjdHMgYC0tZm9vYCwgbm90IGAtZmAgb3IgYC0tZm9vPWJhcmApICovXG4gIGJvb2xlYW4/OiBib29sZWFuIHwgc3RyaW5nIHwgc3RyaW5nW107XG5cbiAgLyoqIEFuIG9iamVjdCBtYXBwaW5nIHN0cmluZyBhcmd1bWVudCBuYW1lcyB0byBkZWZhdWx0IHZhbHVlcy4gKi9cbiAgZGVmYXVsdD86IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuXG4gIC8qKiBXaGVuIGB0cnVlYCwgcG9wdWxhdGUgdGhlIHJlc3VsdCBgX2Agd2l0aCBldmVyeXRoaW5nIGFmdGVyIHRoZSBmaXJzdFxuICAgKiBub24tb3B0aW9uLiAqL1xuICBzdG9wRWFybHk/OiBib29sZWFuO1xuXG4gIC8qKiBBIHN0cmluZyBvciBhcnJheSBvZiBzdHJpbmdzIGFyZ3VtZW50IG5hbWVzIHRvIGFsd2F5cyB0cmVhdCBhcyBzdHJpbmdzLiAqL1xuICBzdHJpbmc/OiBzdHJpbmcgfCBzdHJpbmdbXTtcblxuICAvKiogQSBmdW5jdGlvbiB3aGljaCBpcyBpbnZva2VkIHdpdGggYSBjb21tYW5kIGxpbmUgcGFyYW1ldGVyIG5vdCBkZWZpbmVkIGluXG4gICAqIHRoZSBgb3B0aW9uc2AgY29uZmlndXJhdGlvbiBvYmplY3QuIElmIHRoZSBmdW5jdGlvbiByZXR1cm5zIGBmYWxzZWAsIHRoZVxuICAgKiB1bmtub3duIG9wdGlvbiBpcyBub3QgYWRkZWQgdG8gYHBhcnNlZEFyZ3NgLiAqL1xuICB1bmtub3duPzogKGFyZzogc3RyaW5nLCBrZXk/OiBzdHJpbmcsIHZhbHVlPzogdW5rbm93bikgPT4gdW5rbm93bjtcbn1cblxuaW50ZXJmYWNlIEZsYWdzIHtcbiAgYm9vbHM6IFJlY29yZDxzdHJpbmcsIGJvb2xlYW4+O1xuICBzdHJpbmdzOiBSZWNvcmQ8c3RyaW5nLCBib29sZWFuPjtcbiAgdW5rbm93bkZuOiAoYXJnOiBzdHJpbmcsIGtleT86IHN0cmluZywgdmFsdWU/OiB1bmtub3duKSA9PiB1bmtub3duO1xuICBhbGxCb29sczogYm9vbGVhbjtcbn1cblxuaW50ZXJmYWNlIE5lc3RlZE1hcHBpbmcge1xuICBba2V5OiBzdHJpbmddOiBOZXN0ZWRNYXBwaW5nIHwgdW5rbm93bjtcbn1cblxuZnVuY3Rpb24gZ2V0PFQ+KG9iajogUmVjb3JkPHN0cmluZywgVD4sIGtleTogc3RyaW5nKTogVCB8IHVuZGVmaW5lZCB7XG4gIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwob2JqLCBrZXkpKSB7XG4gICAgcmV0dXJuIG9ialtrZXldO1xuICB9XG59XG5cbmZ1bmN0aW9uIGdldEZvcmNlPFQ+KG9iajogUmVjb3JkPHN0cmluZywgVD4sIGtleTogc3RyaW5nKTogVCB7XG4gIGNvbnN0IHYgPSBnZXQob2JqLCBrZXkpO1xuICBhc3NlcnQodiAhPSBudWxsKTtcbiAgcmV0dXJuIHY7XG59XG5cbmZ1bmN0aW9uIGlzTnVtYmVyKHg6IHVua25vd24pOiBib29sZWFuIHtcbiAgaWYgKHR5cGVvZiB4ID09PSBcIm51bWJlclwiKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKC9eMHhbMC05YS1mXSskL2kudGVzdChTdHJpbmcoeCkpKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIC9eWy0rXT8oPzpcXGQrKD86XFwuXFxkKik/fFxcLlxcZCspKGVbLStdP1xcZCspPyQvLnRlc3QoU3RyaW5nKHgpKTtcbn1cblxuZnVuY3Rpb24gaGFzS2V5KG9iajogTmVzdGVkTWFwcGluZywga2V5czogc3RyaW5nW10pOiBib29sZWFuIHtcbiAgbGV0IG8gPSBvYmo7XG4gIGtleXMuc2xpY2UoMCwgLTEpLmZvckVhY2goKGtleSkgPT4ge1xuICAgIG8gPSAoZ2V0KG8sIGtleSkgPz8ge30pIGFzIE5lc3RlZE1hcHBpbmc7XG4gIH0pO1xuXG4gIGNvbnN0IGtleSA9IGtleXNba2V5cy5sZW5ndGggLSAxXTtcbiAgcmV0dXJuIGtleSBpbiBvO1xufVxuXG4vKiogVGFrZSBhIHNldCBvZiBjb21tYW5kIGxpbmUgYXJndW1lbnRzLCB3aXRoIGFuIG9wdGlvbmFsIHNldCBvZiBvcHRpb25zLCBhbmRcbiAqIHJldHVybiBhbiBvYmplY3QgcmVwcmVzZW50YXRpb24gb2YgdGhvc2UgYXJndW1lbnQuXG4gKlxuICogICAgICBjb25zdCBwYXJzZWRBcmdzID0gcGFyc2UoRGVuby5hcmdzKTtcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlKFxuICBhcmdzOiBzdHJpbmdbXSxcbiAge1xuICAgIFwiLS1cIjogZG91YmxlRGFzaCA9IGZhbHNlLFxuICAgIGFsaWFzID0ge30sXG4gICAgYm9vbGVhbiA9IGZhbHNlLFxuICAgIGRlZmF1bHQ6IGRlZmF1bHRzID0ge30sXG4gICAgc3RvcEVhcmx5ID0gZmFsc2UsXG4gICAgc3RyaW5nID0gW10sXG4gICAgdW5rbm93biA9IChpOiBzdHJpbmcpOiB1bmtub3duID0+IGksXG4gIH06IEFyZ1BhcnNpbmdPcHRpb25zID0ge30sXG4pOiBBcmdzIHtcbiAgY29uc3QgZmxhZ3M6IEZsYWdzID0ge1xuICAgIGJvb2xzOiB7fSxcbiAgICBzdHJpbmdzOiB7fSxcbiAgICB1bmtub3duRm46IHVua25vd24sXG4gICAgYWxsQm9vbHM6IGZhbHNlLFxuICB9O1xuXG4gIGlmIChib29sZWFuICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAodHlwZW9mIGJvb2xlYW4gPT09IFwiYm9vbGVhblwiKSB7XG4gICAgICBmbGFncy5hbGxCb29scyA9ICEhYm9vbGVhbjtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgYm9vbGVhbkFyZ3MgPSB0eXBlb2YgYm9vbGVhbiA9PT0gXCJzdHJpbmdcIiA/IFtib29sZWFuXSA6IGJvb2xlYW47XG5cbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIGJvb2xlYW5BcmdzLmZpbHRlcihCb29sZWFuKSkge1xuICAgICAgICBmbGFncy5ib29sc1trZXldID0gdHJ1ZTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBjb25zdCBhbGlhc2VzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmdbXT4gPSB7fTtcbiAgaWYgKGFsaWFzICE9PSB1bmRlZmluZWQpIHtcbiAgICBmb3IgKGNvbnN0IGtleSBpbiBhbGlhcykge1xuICAgICAgY29uc3QgdmFsID0gZ2V0Rm9yY2UoYWxpYXMsIGtleSk7XG4gICAgICBpZiAodHlwZW9mIHZhbCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICBhbGlhc2VzW2tleV0gPSBbdmFsXTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGFsaWFzZXNba2V5XSA9IHZhbDtcbiAgICAgIH1cbiAgICAgIGZvciAoY29uc3QgYWxpYXMgb2YgZ2V0Rm9yY2UoYWxpYXNlcywga2V5KSkge1xuICAgICAgICBhbGlhc2VzW2FsaWFzXSA9IFtrZXldLmNvbmNhdChhbGlhc2VzW2tleV0uZmlsdGVyKCh5KSA9PiBhbGlhcyAhPT0geSkpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGlmIChzdHJpbmcgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHN0cmluZ0FyZ3MgPSB0eXBlb2Ygc3RyaW5nID09PSBcInN0cmluZ1wiID8gW3N0cmluZ10gOiBzdHJpbmc7XG5cbiAgICBmb3IgKGNvbnN0IGtleSBvZiBzdHJpbmdBcmdzLmZpbHRlcihCb29sZWFuKSkge1xuICAgICAgZmxhZ3Muc3RyaW5nc1trZXldID0gdHJ1ZTtcbiAgICAgIGNvbnN0IGFsaWFzID0gZ2V0KGFsaWFzZXMsIGtleSk7XG4gICAgICBpZiAoYWxpYXMpIHtcbiAgICAgICAgZm9yIChjb25zdCBhbCBvZiBhbGlhcykge1xuICAgICAgICAgIGZsYWdzLnN0cmluZ3NbYWxdID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGFyZ3Y6IEFyZ3MgPSB7IF86IFtdIH07XG5cbiAgZnVuY3Rpb24gYXJnRGVmaW5lZChrZXk6IHN0cmluZywgYXJnOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gKFxuICAgICAgKGZsYWdzLmFsbEJvb2xzICYmIC9eLS1bXj1dKyQvLnRlc3QoYXJnKSkgfHxcbiAgICAgIGdldChmbGFncy5ib29scywga2V5KSB8fFxuICAgICAgISFnZXQoZmxhZ3Muc3RyaW5ncywga2V5KSB8fFxuICAgICAgISFnZXQoYWxpYXNlcywga2V5KVxuICAgICk7XG4gIH1cblxuICBmdW5jdGlvbiBzZXRLZXkob2JqOiBOZXN0ZWRNYXBwaW5nLCBrZXlzOiBzdHJpbmdbXSwgdmFsdWU6IHVua25vd24pOiB2b2lkIHtcbiAgICBsZXQgbyA9IG9iajtcbiAgICBrZXlzLnNsaWNlKDAsIC0xKS5mb3JFYWNoKGZ1bmN0aW9uIChrZXkpOiB2b2lkIHtcbiAgICAgIGlmIChnZXQobywga2V5KSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIG9ba2V5XSA9IHt9O1xuICAgICAgfVxuICAgICAgbyA9IGdldChvLCBrZXkpIGFzIE5lc3RlZE1hcHBpbmc7XG4gICAgfSk7XG5cbiAgICBjb25zdCBrZXkgPSBrZXlzW2tleXMubGVuZ3RoIC0gMV07XG4gICAgaWYgKFxuICAgICAgZ2V0KG8sIGtleSkgPT09IHVuZGVmaW5lZCB8fFxuICAgICAgZ2V0KGZsYWdzLmJvb2xzLCBrZXkpIHx8XG4gICAgICB0eXBlb2YgZ2V0KG8sIGtleSkgPT09IFwiYm9vbGVhblwiXG4gICAgKSB7XG4gICAgICBvW2tleV0gPSB2YWx1ZTtcbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoZ2V0KG8sIGtleSkpKSB7XG4gICAgICAob1trZXldIGFzIHVua25vd25bXSkucHVzaCh2YWx1ZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG9ba2V5XSA9IFtnZXQobywga2V5KSwgdmFsdWVdO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHNldEFyZyhcbiAgICBrZXk6IHN0cmluZyxcbiAgICB2YWw6IHVua25vd24sXG4gICAgYXJnOiBzdHJpbmcgfCB1bmRlZmluZWQgPSB1bmRlZmluZWQsXG4gICk6IHZvaWQge1xuICAgIGlmIChhcmcgJiYgZmxhZ3MudW5rbm93bkZuICYmICFhcmdEZWZpbmVkKGtleSwgYXJnKSkge1xuICAgICAgaWYgKGZsYWdzLnVua25vd25GbihhcmcsIGtleSwgdmFsKSA9PT0gZmFsc2UpIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCB2YWx1ZSA9ICFnZXQoZmxhZ3Muc3RyaW5ncywga2V5KSAmJiBpc051bWJlcih2YWwpID8gTnVtYmVyKHZhbCkgOiB2YWw7XG4gICAgc2V0S2V5KGFyZ3YsIGtleS5zcGxpdChcIi5cIiksIHZhbHVlKTtcblxuICAgIGNvbnN0IGFsaWFzID0gZ2V0KGFsaWFzZXMsIGtleSk7XG4gICAgaWYgKGFsaWFzKSB7XG4gICAgICBmb3IgKGNvbnN0IHggb2YgYWxpYXMpIHtcbiAgICAgICAgc2V0S2V5KGFyZ3YsIHguc3BsaXQoXCIuXCIpLCB2YWx1ZSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gYWxpYXNJc0Jvb2xlYW4oa2V5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgICByZXR1cm4gZ2V0Rm9yY2UoYWxpYXNlcywga2V5KS5zb21lKFxuICAgICAgKHgpID0+IHR5cGVvZiBnZXQoZmxhZ3MuYm9vbHMsIHgpID09PSBcImJvb2xlYW5cIixcbiAgICApO1xuICB9XG5cbiAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMoZmxhZ3MuYm9vbHMpKSB7XG4gICAgc2V0QXJnKGtleSwgZGVmYXVsdHNba2V5XSA9PT0gdW5kZWZpbmVkID8gZmFsc2UgOiBkZWZhdWx0c1trZXldKTtcbiAgfVxuXG4gIGxldCBub3RGbGFnczogc3RyaW5nW10gPSBbXTtcblxuICAvLyBhbGwgYXJncyBhZnRlciBcIi0tXCIgYXJlIG5vdCBwYXJzZWRcbiAgaWYgKGFyZ3MuaW5jbHVkZXMoXCItLVwiKSkge1xuICAgIG5vdEZsYWdzID0gYXJncy5zbGljZShhcmdzLmluZGV4T2YoXCItLVwiKSArIDEpO1xuICAgIGFyZ3MgPSBhcmdzLnNsaWNlKDAsIGFyZ3MuaW5kZXhPZihcIi0tXCIpKTtcbiAgfVxuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYXJncy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGFyZyA9IGFyZ3NbaV07XG5cbiAgICBpZiAoL14tLS4rPS8udGVzdChhcmcpKSB7XG4gICAgICBjb25zdCBtID0gYXJnLm1hdGNoKC9eLS0oW149XSspPSguKikkL3MpO1xuICAgICAgYXNzZXJ0KG0gIT0gbnVsbCk7XG4gICAgICBjb25zdCBbLCBrZXksIHZhbHVlXSA9IG07XG5cbiAgICAgIGlmIChmbGFncy5ib29sc1trZXldKSB7XG4gICAgICAgIGNvbnN0IGJvb2xlYW5WYWx1ZSA9IHZhbHVlICE9PSBcImZhbHNlXCI7XG4gICAgICAgIHNldEFyZyhrZXksIGJvb2xlYW5WYWx1ZSwgYXJnKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNldEFyZyhrZXksIHZhbHVlLCBhcmcpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoL14tLW5vLS4rLy50ZXN0KGFyZykpIHtcbiAgICAgIGNvbnN0IG0gPSBhcmcubWF0Y2goL14tLW5vLSguKykvKTtcbiAgICAgIGFzc2VydChtICE9IG51bGwpO1xuICAgICAgc2V0QXJnKG1bMV0sIGZhbHNlLCBhcmcpO1xuICAgIH0gZWxzZSBpZiAoL14tLS4rLy50ZXN0KGFyZykpIHtcbiAgICAgIGNvbnN0IG0gPSBhcmcubWF0Y2goL14tLSguKykvKTtcbiAgICAgIGFzc2VydChtICE9IG51bGwpO1xuICAgICAgY29uc3QgWywga2V5XSA9IG07XG4gICAgICBjb25zdCBuZXh0ID0gYXJnc1tpICsgMV07XG4gICAgICBpZiAoXG4gICAgICAgIG5leHQgIT09IHVuZGVmaW5lZCAmJlxuICAgICAgICAhL14tLy50ZXN0KG5leHQpICYmXG4gICAgICAgICFnZXQoZmxhZ3MuYm9vbHMsIGtleSkgJiZcbiAgICAgICAgIWZsYWdzLmFsbEJvb2xzICYmXG4gICAgICAgIChnZXQoYWxpYXNlcywga2V5KSA/ICFhbGlhc0lzQm9vbGVhbihrZXkpIDogdHJ1ZSlcbiAgICAgICkge1xuICAgICAgICBzZXRBcmcoa2V5LCBuZXh0LCBhcmcpO1xuICAgICAgICBpKys7XG4gICAgICB9IGVsc2UgaWYgKC9eKHRydWV8ZmFsc2UpJC8udGVzdChuZXh0KSkge1xuICAgICAgICBzZXRBcmcoa2V5LCBuZXh0ID09PSBcInRydWVcIiwgYXJnKTtcbiAgICAgICAgaSsrO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2V0QXJnKGtleSwgZ2V0KGZsYWdzLnN0cmluZ3MsIGtleSkgPyBcIlwiIDogdHJ1ZSwgYXJnKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKC9eLVteLV0rLy50ZXN0KGFyZykpIHtcbiAgICAgIGNvbnN0IGxldHRlcnMgPSBhcmcuc2xpY2UoMSwgLTEpLnNwbGl0KFwiXCIpO1xuXG4gICAgICBsZXQgYnJva2VuID0gZmFsc2U7XG4gICAgICBmb3IgKGxldCBqID0gMDsgaiA8IGxldHRlcnMubGVuZ3RoOyBqKyspIHtcbiAgICAgICAgY29uc3QgbmV4dCA9IGFyZy5zbGljZShqICsgMik7XG5cbiAgICAgICAgaWYgKG5leHQgPT09IFwiLVwiKSB7XG4gICAgICAgICAgc2V0QXJnKGxldHRlcnNbal0sIG5leHQsIGFyZyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoL1tBLVphLXpdLy50ZXN0KGxldHRlcnNbal0pICYmIC89Ly50ZXN0KG5leHQpKSB7XG4gICAgICAgICAgc2V0QXJnKGxldHRlcnNbal0sIG5leHQuc3BsaXQoLz0oLispLylbMV0sIGFyZyk7XG4gICAgICAgICAgYnJva2VuID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChcbiAgICAgICAgICAvW0EtWmEtel0vLnRlc3QobGV0dGVyc1tqXSkgJiZcbiAgICAgICAgICAvLT9cXGQrKFxcLlxcZCopPyhlLT9cXGQrKT8kLy50ZXN0KG5leHQpXG4gICAgICAgICkge1xuICAgICAgICAgIHNldEFyZyhsZXR0ZXJzW2pdLCBuZXh0LCBhcmcpO1xuICAgICAgICAgIGJyb2tlbiA9IHRydWU7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobGV0dGVyc1tqICsgMV0gJiYgbGV0dGVyc1tqICsgMV0ubWF0Y2goL1xcVy8pKSB7XG4gICAgICAgICAgc2V0QXJnKGxldHRlcnNbal0sIGFyZy5zbGljZShqICsgMiksIGFyZyk7XG4gICAgICAgICAgYnJva2VuID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBzZXRBcmcobGV0dGVyc1tqXSwgZ2V0KGZsYWdzLnN0cmluZ3MsIGxldHRlcnNbal0pID8gXCJcIiA6IHRydWUsIGFyZyk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgY29uc3QgW2tleV0gPSBhcmcuc2xpY2UoLTEpO1xuICAgICAgaWYgKCFicm9rZW4gJiYga2V5ICE9PSBcIi1cIikge1xuICAgICAgICBpZiAoXG4gICAgICAgICAgYXJnc1tpICsgMV0gJiZcbiAgICAgICAgICAhL14oLXwtLSlbXi1dLy50ZXN0KGFyZ3NbaSArIDFdKSAmJlxuICAgICAgICAgICFnZXQoZmxhZ3MuYm9vbHMsIGtleSkgJiZcbiAgICAgICAgICAoZ2V0KGFsaWFzZXMsIGtleSkgPyAhYWxpYXNJc0Jvb2xlYW4oa2V5KSA6IHRydWUpXG4gICAgICAgICkge1xuICAgICAgICAgIHNldEFyZyhrZXksIGFyZ3NbaSArIDFdLCBhcmcpO1xuICAgICAgICAgIGkrKztcbiAgICAgICAgfSBlbHNlIGlmIChhcmdzW2kgKyAxXSAmJiAvXih0cnVlfGZhbHNlKSQvLnRlc3QoYXJnc1tpICsgMV0pKSB7XG4gICAgICAgICAgc2V0QXJnKGtleSwgYXJnc1tpICsgMV0gPT09IFwidHJ1ZVwiLCBhcmcpO1xuICAgICAgICAgIGkrKztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBzZXRBcmcoa2V5LCBnZXQoZmxhZ3Muc3RyaW5ncywga2V5KSA/IFwiXCIgOiB0cnVlLCBhcmcpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGlmICghZmxhZ3MudW5rbm93bkZuIHx8IGZsYWdzLnVua25vd25GbihhcmcpICE9PSBmYWxzZSkge1xuICAgICAgICBhcmd2Ll8ucHVzaChmbGFncy5zdHJpbmdzW1wiX1wiXSA/PyAhaXNOdW1iZXIoYXJnKSA/IGFyZyA6IE51bWJlcihhcmcpKTtcbiAgICAgIH1cbiAgICAgIGlmIChzdG9wRWFybHkpIHtcbiAgICAgICAgYXJndi5fLnB1c2goLi4uYXJncy5zbGljZShpICsgMSkpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhkZWZhdWx0cykpIHtcbiAgICBpZiAoIWhhc0tleShhcmd2LCBrZXkuc3BsaXQoXCIuXCIpKSkge1xuICAgICAgc2V0S2V5KGFyZ3YsIGtleS5zcGxpdChcIi5cIiksIGRlZmF1bHRzW2tleV0pO1xuXG4gICAgICBpZiAoYWxpYXNlc1trZXldKSB7XG4gICAgICAgIGZvciAoY29uc3QgeCBvZiBhbGlhc2VzW2tleV0pIHtcbiAgICAgICAgICBzZXRLZXkoYXJndiwgeC5zcGxpdChcIi5cIiksIGRlZmF1bHRzW2tleV0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKGRvdWJsZURhc2gpIHtcbiAgICBhcmd2W1wiLS1cIl0gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBub3RGbGFncykge1xuICAgICAgYXJndltcIi0tXCJdLnB1c2goa2V5KTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgZm9yIChjb25zdCBrZXkgb2Ygbm90RmxhZ3MpIHtcbiAgICAgIGFyZ3YuXy5wdXNoKGtleSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGFyZ3Y7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsRUFBQSx3RUFBQTtTQUVBLE1BQUEsU0FBQSxrQkFBQTtTQTZEQSxHQUFBLENBQUEsR0FBQSxFQUFBLEdBQUE7UUFDQSxNQUFBLENBQUEsU0FBQSxDQUFBLGNBQUEsQ0FBQSxJQUFBLENBQUEsR0FBQSxFQUFBLEdBQUE7ZUFDQSxHQUFBLENBQUEsR0FBQTs7O1NBSUEsUUFBQSxDQUFBLEdBQUEsRUFBQSxHQUFBO1VBQ0EsQ0FBQSxHQUFBLEdBQUEsQ0FBQSxHQUFBLEVBQUEsR0FBQTtBQUNBLFVBQUEsQ0FBQSxDQUFBLElBQUEsSUFBQTtXQUNBLENBQUE7O1NBR0EsUUFBQSxDQUFBLENBQUE7ZUFDQSxDQUFBLE1BQUEsTUFBQSxVQUFBLElBQUE7eUJBQ0EsSUFBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBLFdBQUEsSUFBQTt3REFDQSxJQUFBLENBQUEsTUFBQSxDQUFBLENBQUE7O1NBR0EsTUFBQSxDQUFBLEdBQUEsRUFBQSxJQUFBO1FBQ0EsQ0FBQSxHQUFBLEdBQUE7QUFDQSxRQUFBLENBQUEsS0FBQSxDQUFBLENBQUEsR0FBQSxDQUFBLEVBQUEsT0FBQSxFQUFBLEdBQUE7QUFDQSxTQUFBLEdBQUEsR0FBQSxDQUFBLENBQUEsRUFBQSxHQUFBOzs7VUFHQSxHQUFBLEdBQUEsSUFBQSxDQUFBLElBQUEsQ0FBQSxNQUFBLEdBQUEsQ0FBQTtXQUNBLEdBQUEsSUFBQSxDQUFBOztBQUdBLEVBSUEsQUFKQSxvTEFJQSxBQUpBLEVBSUEsaUJBQ0EsS0FBQSxDQUNBLElBQUEsS0FFQSxFQUFBLEdBQUEsVUFBQSxHQUFBLEtBQUEsR0FDQSxLQUFBO0lBQ0EsT0FBQSxFQUFBLEtBQUEsR0FDQSxPQUFBLEVBQUEsUUFBQTtJQUNBLFNBQUEsRUFBQSxLQUFBLEdBQ0EsTUFBQSxPQUNBLE9BQUEsR0FBQSxDQUFBLEdBQUEsQ0FBQTs7O1VBR0EsS0FBQTtBQUNBLGFBQUE7O0FBQ0EsZUFBQTs7QUFDQSxpQkFBQSxFQUFBLE9BQUE7QUFDQSxnQkFBQSxFQUFBLEtBQUE7O1FBR0EsT0FBQSxLQUFBLFNBQUE7bUJBQ0EsT0FBQSxNQUFBLE9BQUE7QUFDQSxpQkFBQSxDQUFBLFFBQUEsS0FBQSxPQUFBOztrQkFFQSxXQUFBLFVBQUEsT0FBQSxNQUFBLE1BQUE7QUFBQSx1QkFBQTtnQkFBQSxPQUFBO3VCQUVBLEdBQUEsSUFBQSxXQUFBLENBQUEsTUFBQSxDQUFBLE9BQUE7QUFDQSxxQkFBQSxDQUFBLEtBQUEsQ0FBQSxHQUFBLElBQUEsSUFBQTs7OztVQUtBLE9BQUE7O1FBQ0EsS0FBQSxLQUFBLFNBQUE7a0JBQ0EsR0FBQSxJQUFBLEtBQUE7a0JBQ0EsR0FBQSxHQUFBLFFBQUEsQ0FBQSxLQUFBLEVBQUEsR0FBQTt1QkFDQSxHQUFBLE1BQUEsTUFBQTtBQUNBLHVCQUFBLENBQUEsR0FBQTtBQUFBLHVCQUFBOzs7QUFFQSx1QkFBQSxDQUFBLEdBQUEsSUFBQSxHQUFBOzt1QkFFQSxLQUFBLElBQUEsUUFBQSxDQUFBLE9BQUEsRUFBQSxHQUFBO0FBQ0EsdUJBQUEsQ0FBQSxLQUFBO0FBQUEsdUJBQUE7a0JBQUEsTUFBQSxDQUFBLE9BQUEsQ0FBQSxHQUFBLEVBQUEsTUFBQSxFQUFBLENBQUEsR0FBQSxLQUFBLEtBQUEsQ0FBQTs7Ozs7UUFLQSxNQUFBLEtBQUEsU0FBQTtjQUNBLFVBQUEsVUFBQSxNQUFBLE1BQUEsTUFBQTtBQUFBLGtCQUFBO1lBQUEsTUFBQTttQkFFQSxHQUFBLElBQUEsVUFBQSxDQUFBLE1BQUEsQ0FBQSxPQUFBO0FBQ0EsaUJBQUEsQ0FBQSxPQUFBLENBQUEsR0FBQSxJQUFBLElBQUE7a0JBQ0EsS0FBQSxHQUFBLEdBQUEsQ0FBQSxPQUFBLEVBQUEsR0FBQTtnQkFDQSxLQUFBOzJCQUNBLEVBQUEsSUFBQSxLQUFBO0FBQ0EseUJBQUEsQ0FBQSxPQUFBLENBQUEsRUFBQSxJQUFBLElBQUE7Ozs7O1VBTUEsSUFBQTtBQUFBLFNBQUE7O2FBRUEsVUFBQSxDQUFBLEdBQUEsRUFBQSxHQUFBO2VBRUEsS0FBQSxDQUFBLFFBQUEsZ0JBQUEsSUFBQSxDQUFBLEdBQUEsS0FDQSxHQUFBLENBQUEsS0FBQSxDQUFBLEtBQUEsRUFBQSxHQUFBLE9BQ0EsR0FBQSxDQUFBLEtBQUEsQ0FBQSxPQUFBLEVBQUEsR0FBQSxPQUNBLEdBQUEsQ0FBQSxPQUFBLEVBQUEsR0FBQTs7YUFJQSxNQUFBLENBQUEsR0FBQSxFQUFBLElBQUEsRUFBQSxLQUFBO1lBQ0EsQ0FBQSxHQUFBLEdBQUE7QUFDQSxZQUFBLENBQUEsS0FBQSxDQUFBLENBQUEsR0FBQSxDQUFBLEVBQUEsT0FBQSxVQUFBLEdBQUE7Z0JBQ0EsR0FBQSxDQUFBLENBQUEsRUFBQSxHQUFBLE1BQUEsU0FBQTtBQUNBLGlCQUFBLENBQUEsR0FBQTs7O0FBRUEsYUFBQSxHQUFBLEdBQUEsQ0FBQSxDQUFBLEVBQUEsR0FBQTs7Y0FHQSxHQUFBLEdBQUEsSUFBQSxDQUFBLElBQUEsQ0FBQSxNQUFBLEdBQUEsQ0FBQTtZQUVBLEdBQUEsQ0FBQSxDQUFBLEVBQUEsR0FBQSxNQUFBLFNBQUEsSUFDQSxHQUFBLENBQUEsS0FBQSxDQUFBLEtBQUEsRUFBQSxHQUFBLFlBQ0EsR0FBQSxDQUFBLENBQUEsRUFBQSxHQUFBLE9BQUEsT0FBQTtBQUVBLGFBQUEsQ0FBQSxHQUFBLElBQUEsS0FBQTttQkFDQSxLQUFBLENBQUEsT0FBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLEVBQUEsR0FBQTtBQUNBLGFBQUEsQ0FBQSxHQUFBLEVBQUEsSUFBQSxDQUFBLEtBQUE7O0FBRUEsYUFBQSxDQUFBLEdBQUE7QUFBQSxtQkFBQSxDQUFBLENBQUEsRUFBQSxHQUFBO0FBQUEscUJBQUE7Ozs7YUFJQSxNQUFBLENBQ0EsR0FBQSxFQUNBLEdBQUEsRUFDQSxHQUFBLEdBQUEsU0FBQTtZQUVBLEdBQUEsSUFBQSxLQUFBLENBQUEsU0FBQSxLQUFBLFVBQUEsQ0FBQSxHQUFBLEVBQUEsR0FBQTtnQkFDQSxLQUFBLENBQUEsU0FBQSxDQUFBLEdBQUEsRUFBQSxHQUFBLEVBQUEsR0FBQSxNQUFBLEtBQUE7O2NBR0EsS0FBQSxJQUFBLEdBQUEsQ0FBQSxLQUFBLENBQUEsT0FBQSxFQUFBLEdBQUEsS0FBQSxRQUFBLENBQUEsR0FBQSxJQUFBLE1BQUEsQ0FBQSxHQUFBLElBQUEsR0FBQTtBQUNBLGNBQUEsQ0FBQSxJQUFBLEVBQUEsR0FBQSxDQUFBLEtBQUEsRUFBQSxDQUFBLElBQUEsS0FBQTtjQUVBLEtBQUEsR0FBQSxHQUFBLENBQUEsT0FBQSxFQUFBLEdBQUE7WUFDQSxLQUFBO3VCQUNBLENBQUEsSUFBQSxLQUFBO0FBQ0Esc0JBQUEsQ0FBQSxJQUFBLEVBQUEsQ0FBQSxDQUFBLEtBQUEsRUFBQSxDQUFBLElBQUEsS0FBQTs7OzthQUtBLGNBQUEsQ0FBQSxHQUFBO2VBQ0EsUUFBQSxDQUFBLE9BQUEsRUFBQSxHQUFBLEVBQUEsSUFBQSxFQUNBLENBQUEsVUFBQSxHQUFBLENBQUEsS0FBQSxDQUFBLEtBQUEsRUFBQSxDQUFBLE9BQUEsT0FBQTs7O2VBSUEsR0FBQSxJQUFBLE1BQUEsQ0FBQSxJQUFBLENBQUEsS0FBQSxDQUFBLEtBQUE7QUFDQSxjQUFBLENBQUEsR0FBQSxFQUFBLFFBQUEsQ0FBQSxHQUFBLE1BQUEsU0FBQSxHQUFBLEtBQUEsR0FBQSxRQUFBLENBQUEsR0FBQTs7UUFHQSxRQUFBO0FBRUEsTUFBQSxtQ0FBQTtRQUNBLElBQUEsQ0FBQSxRQUFBLEVBQUEsRUFBQTtBQUNBLGdCQUFBLEdBQUEsSUFBQSxDQUFBLEtBQUEsQ0FBQSxJQUFBLENBQUEsT0FBQSxFQUFBLEVBQUEsS0FBQSxDQUFBO0FBQ0EsWUFBQSxHQUFBLElBQUEsQ0FBQSxLQUFBLENBQUEsQ0FBQSxFQUFBLElBQUEsQ0FBQSxPQUFBLEVBQUEsRUFBQTs7WUFHQSxDQUFBLEdBQUEsQ0FBQSxFQUFBLENBQUEsR0FBQSxJQUFBLENBQUEsTUFBQSxFQUFBLENBQUE7Y0FDQSxHQUFBLEdBQUEsSUFBQSxDQUFBLENBQUE7cUJBRUEsSUFBQSxDQUFBLEdBQUE7a0JBQ0EsQ0FBQSxHQUFBLEdBQUEsQ0FBQSxLQUFBO0FBQ0Esa0JBQUEsQ0FBQSxDQUFBLElBQUEsSUFBQTtxQkFDQSxHQUFBLEVBQUEsS0FBQSxJQUFBLENBQUE7Z0JBRUEsS0FBQSxDQUFBLEtBQUEsQ0FBQSxHQUFBO3NCQUNBLFlBQUEsR0FBQSxLQUFBLE1BQUEsS0FBQTtBQUNBLHNCQUFBLENBQUEsR0FBQSxFQUFBLFlBQUEsRUFBQSxHQUFBOztBQUVBLHNCQUFBLENBQUEsR0FBQSxFQUFBLEtBQUEsRUFBQSxHQUFBOzs4QkFFQSxJQUFBLENBQUEsR0FBQTtrQkFDQSxDQUFBLEdBQUEsR0FBQSxDQUFBLEtBQUE7QUFDQSxrQkFBQSxDQUFBLENBQUEsSUFBQSxJQUFBO0FBQ0Esa0JBQUEsQ0FBQSxDQUFBLENBQUEsQ0FBQSxHQUFBLEtBQUEsRUFBQSxHQUFBOzJCQUNBLElBQUEsQ0FBQSxHQUFBO2tCQUNBLENBQUEsR0FBQSxHQUFBLENBQUEsS0FBQTtBQUNBLGtCQUFBLENBQUEsQ0FBQSxJQUFBLElBQUE7cUJBQ0EsR0FBQSxJQUFBLENBQUE7a0JBQ0EsSUFBQSxHQUFBLElBQUEsQ0FBQSxDQUFBLEdBQUEsQ0FBQTtnQkFFQSxJQUFBLEtBQUEsU0FBQSxVQUNBLElBQUEsQ0FBQSxJQUFBLE1BQ0EsR0FBQSxDQUFBLEtBQUEsQ0FBQSxLQUFBLEVBQUEsR0FBQSxNQUNBLEtBQUEsQ0FBQSxRQUFBLEtBQ0EsR0FBQSxDQUFBLE9BQUEsRUFBQSxHQUFBLEtBQUEsY0FBQSxDQUFBLEdBQUEsSUFBQSxJQUFBO0FBRUEsc0JBQUEsQ0FBQSxHQUFBLEVBQUEsSUFBQSxFQUFBLEdBQUE7QUFDQSxpQkFBQTt3Q0FDQSxJQUFBLENBQUEsSUFBQTtBQUNBLHNCQUFBLENBQUEsR0FBQSxFQUFBLElBQUEsTUFBQSxJQUFBLEdBQUEsR0FBQTtBQUNBLGlCQUFBOztBQUVBLHNCQUFBLENBQUEsR0FBQSxFQUFBLEdBQUEsQ0FBQSxLQUFBLENBQUEsT0FBQSxFQUFBLEdBQUEsU0FBQSxJQUFBLEVBQUEsR0FBQTs7NkJBRUEsSUFBQSxDQUFBLEdBQUE7a0JBQ0EsT0FBQSxHQUFBLEdBQUEsQ0FBQSxLQUFBLENBQUEsQ0FBQSxHQUFBLENBQUEsRUFBQSxLQUFBO2dCQUVBLE1BQUEsR0FBQSxLQUFBO29CQUNBLENBQUEsR0FBQSxDQUFBLEVBQUEsQ0FBQSxHQUFBLE9BQUEsQ0FBQSxNQUFBLEVBQUEsQ0FBQTtzQkFDQSxJQUFBLEdBQUEsR0FBQSxDQUFBLEtBQUEsQ0FBQSxDQUFBLEdBQUEsQ0FBQTtvQkFFQSxJQUFBLE1BQUEsQ0FBQTtBQUNBLDBCQUFBLENBQUEsT0FBQSxDQUFBLENBQUEsR0FBQSxJQUFBLEVBQUEsR0FBQTs7OytCQUlBLElBQUEsQ0FBQSxPQUFBLENBQUEsQ0FBQSxVQUFBLElBQUEsQ0FBQSxJQUFBO0FBQ0EsMEJBQUEsQ0FBQSxPQUFBLENBQUEsQ0FBQSxHQUFBLElBQUEsQ0FBQSxLQUFBLFVBQUEsQ0FBQSxHQUFBLEdBQUE7QUFDQSwwQkFBQSxHQUFBLElBQUE7OzsrQkFLQSxJQUFBLENBQUEsT0FBQSxDQUFBLENBQUEsZ0NBQ0EsSUFBQSxDQUFBLElBQUE7QUFFQSwwQkFBQSxDQUFBLE9BQUEsQ0FBQSxDQUFBLEdBQUEsSUFBQSxFQUFBLEdBQUE7QUFDQSwwQkFBQSxHQUFBLElBQUE7OztvQkFJQSxPQUFBLENBQUEsQ0FBQSxHQUFBLENBQUEsS0FBQSxPQUFBLENBQUEsQ0FBQSxHQUFBLENBQUEsRUFBQSxLQUFBO0FBQ0EsMEJBQUEsQ0FBQSxPQUFBLENBQUEsQ0FBQSxHQUFBLEdBQUEsQ0FBQSxLQUFBLENBQUEsQ0FBQSxHQUFBLENBQUEsR0FBQSxHQUFBO0FBQ0EsMEJBQUEsR0FBQSxJQUFBOzs7QUFHQSwwQkFBQSxDQUFBLE9BQUEsQ0FBQSxDQUFBLEdBQUEsR0FBQSxDQUFBLEtBQUEsQ0FBQSxPQUFBLEVBQUEsT0FBQSxDQUFBLENBQUEsVUFBQSxJQUFBLEVBQUEsR0FBQTs7O21CQUlBLEdBQUEsSUFBQSxHQUFBLENBQUEsS0FBQSxFQUFBLENBQUE7aUJBQ0EsTUFBQSxJQUFBLEdBQUEsTUFBQSxDQUFBO29CQUVBLElBQUEsQ0FBQSxDQUFBLEdBQUEsQ0FBQSxvQkFDQSxJQUFBLENBQUEsSUFBQSxDQUFBLENBQUEsR0FBQSxDQUFBLE9BQ0EsR0FBQSxDQUFBLEtBQUEsQ0FBQSxLQUFBLEVBQUEsR0FBQSxNQUNBLEdBQUEsQ0FBQSxPQUFBLEVBQUEsR0FBQSxLQUFBLGNBQUEsQ0FBQSxHQUFBLElBQUEsSUFBQTtBQUVBLDBCQUFBLENBQUEsR0FBQSxFQUFBLElBQUEsQ0FBQSxDQUFBLEdBQUEsQ0FBQSxHQUFBLEdBQUE7QUFDQSxxQkFBQTsyQkFDQSxJQUFBLENBQUEsQ0FBQSxHQUFBLENBQUEsc0JBQUEsSUFBQSxDQUFBLElBQUEsQ0FBQSxDQUFBLEdBQUEsQ0FBQTtBQUNBLDBCQUFBLENBQUEsR0FBQSxFQUFBLElBQUEsQ0FBQSxDQUFBLEdBQUEsQ0FBQSxPQUFBLElBQUEsR0FBQSxHQUFBO0FBQ0EscUJBQUE7O0FBRUEsMEJBQUEsQ0FBQSxHQUFBLEVBQUEsR0FBQSxDQUFBLEtBQUEsQ0FBQSxPQUFBLEVBQUEsR0FBQSxTQUFBLElBQUEsRUFBQSxHQUFBOzs7O2lCQUlBLEtBQUEsQ0FBQSxTQUFBLElBQUEsS0FBQSxDQUFBLFNBQUEsQ0FBQSxHQUFBLE1BQUEsS0FBQTtBQUNBLG9CQUFBLENBQUEsQ0FBQSxDQUFBLElBQUEsQ0FBQSxLQUFBLENBQUEsT0FBQSxFQUFBLENBQUEsT0FBQSxRQUFBLENBQUEsR0FBQSxJQUFBLEdBQUEsR0FBQSxNQUFBLENBQUEsR0FBQTs7Z0JBRUEsU0FBQTtBQUNBLG9CQUFBLENBQUEsQ0FBQSxDQUFBLElBQUEsSUFBQSxJQUFBLENBQUEsS0FBQSxDQUFBLENBQUEsR0FBQSxDQUFBOzs7OztlQU1BLEdBQUEsSUFBQSxNQUFBLENBQUEsSUFBQSxDQUFBLFFBQUE7YUFDQSxNQUFBLENBQUEsSUFBQSxFQUFBLEdBQUEsQ0FBQSxLQUFBLEVBQUEsQ0FBQTtBQUNBLGtCQUFBLENBQUEsSUFBQSxFQUFBLEdBQUEsQ0FBQSxLQUFBLEVBQUEsQ0FBQSxJQUFBLFFBQUEsQ0FBQSxHQUFBO2dCQUVBLE9BQUEsQ0FBQSxHQUFBOzJCQUNBLENBQUEsSUFBQSxPQUFBLENBQUEsR0FBQTtBQUNBLDBCQUFBLENBQUEsSUFBQSxFQUFBLENBQUEsQ0FBQSxLQUFBLEVBQUEsQ0FBQSxJQUFBLFFBQUEsQ0FBQSxHQUFBOzs7OztRQU1BLFVBQUE7QUFDQSxZQUFBLEVBQUEsRUFBQTttQkFDQSxHQUFBLElBQUEsUUFBQTtBQUNBLGdCQUFBLEVBQUEsRUFBQSxHQUFBLElBQUEsQ0FBQSxHQUFBOzs7bUJBR0EsR0FBQSxJQUFBLFFBQUE7QUFDQSxnQkFBQSxDQUFBLENBQUEsQ0FBQSxJQUFBLENBQUEsR0FBQTs7O1dBSUEsSUFBQSJ9