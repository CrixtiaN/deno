// Copyright 2018-2021 the Deno authors. All rights reserved. MIT license.
import { BufWriter } from "../io/bufio.ts";
import { TextProtoReader } from "../textproto/mod.ts";
import { assert } from "../_util/assert.ts";
import { encoder } from "../encoding/utf8.ts";
import { ServerRequest } from "./server.ts";
import { STATUS_TEXT } from "./http_status.ts";
export function emptyReader() {
    return {
        read (_) {
            return Promise.resolve(null);
        }
    };
}
export function bodyReader(contentLength, r) {
    let totalRead = 0;
    let finished = false;
    async function read(buf) {
        if (finished) return null;
        let result;
        const remaining = contentLength - totalRead;
        if (remaining >= buf.byteLength) {
            result = await r.read(buf);
        } else {
            const readBuf = buf.subarray(0, remaining);
            result = await r.read(readBuf);
        }
        if (result !== null) {
            totalRead += result;
        }
        finished = totalRead === contentLength;
        return result;
    }
    return {
        read
    };
}
export function chunkedBodyReader(h, r) {
    // Based on https://tools.ietf.org/html/rfc2616#section-19.4.6
    const tp = new TextProtoReader(r);
    let finished = false;
    const chunks = [];
    async function read(buf) {
        if (finished) return null;
        const [chunk] = chunks;
        if (chunk) {
            const chunkRemaining = chunk.data.byteLength - chunk.offset;
            const readLength = Math.min(chunkRemaining, buf.byteLength);
            for(let i = 0; i < readLength; i++){
                buf[i] = chunk.data[chunk.offset + i];
            }
            chunk.offset += readLength;
            if (chunk.offset === chunk.data.byteLength) {
                chunks.shift();
                // Consume \r\n;
                if (await tp.readLine() === null) {
                    throw new Deno.errors.UnexpectedEof();
                }
            }
            return readLength;
        }
        const line = await tp.readLine();
        if (line === null) throw new Deno.errors.UnexpectedEof();
        // TODO(bartlomieju): handle chunk extension
        const [chunkSizeString] = line.split(";");
        const chunkSize = parseInt(chunkSizeString, 16);
        if (Number.isNaN(chunkSize) || chunkSize < 0) {
            throw new Deno.errors.InvalidData("Invalid chunk size");
        }
        if (chunkSize > 0) {
            if (chunkSize > buf.byteLength) {
                let eof = await r.readFull(buf);
                if (eof === null) {
                    throw new Deno.errors.UnexpectedEof();
                }
                const restChunk = new Uint8Array(chunkSize - buf.byteLength);
                eof = await r.readFull(restChunk);
                if (eof === null) {
                    throw new Deno.errors.UnexpectedEof();
                } else {
                    chunks.push({
                        offset: 0,
                        data: restChunk
                    });
                }
                return buf.byteLength;
            } else {
                const bufToFill = buf.subarray(0, chunkSize);
                const eof = await r.readFull(bufToFill);
                if (eof === null) {
                    throw new Deno.errors.UnexpectedEof();
                }
                // Consume \r\n
                if (await tp.readLine() === null) {
                    throw new Deno.errors.UnexpectedEof();
                }
                return chunkSize;
            }
        } else {
            assert(chunkSize === 0);
            // Consume \r\n
            if (await r.readLine() === null) {
                throw new Deno.errors.UnexpectedEof();
            }
            await readTrailers(h, r);
            finished = true;
            return null;
        }
    }
    return {
        read
    };
}
function isProhibidedForTrailer(key) {
    const s = new Set([
        "transfer-encoding",
        "content-length",
        "trailer"
    ]);
    return s.has(key.toLowerCase());
}
/** Read trailer headers from reader and append values to headers. "trailer"
 * field will be deleted. */ export async function readTrailers(headers, r) {
    const trailers = parseTrailer(headers.get("trailer"));
    if (trailers == null) return;
    const trailerNames = [
        ...trailers.keys()
    ];
    const tp = new TextProtoReader(r);
    const result = await tp.readMIMEHeader();
    if (result == null) {
        throw new Deno.errors.InvalidData("Missing trailer header.");
    }
    const undeclared = [
        ...result.keys()
    ].filter((k)=>!trailerNames.includes(k)
    );
    if (undeclared.length > 0) {
        throw new Deno.errors.InvalidData(`Undeclared trailers: ${Deno.inspect(undeclared)}.`);
    }
    for (const [k, v] of result){
        headers.append(k, v);
    }
    const missingTrailers = trailerNames.filter((k)=>!result.has(k)
    );
    if (missingTrailers.length > 0) {
        throw new Deno.errors.InvalidData(`Missing trailers: ${Deno.inspect(missingTrailers)}.`);
    }
    headers.delete("trailer");
}
function parseTrailer(field) {
    if (field == null) {
        return undefined;
    }
    const trailerNames = field.split(",").map((v)=>v.trim().toLowerCase()
    );
    if (trailerNames.length === 0) {
        throw new Deno.errors.InvalidData("Empty trailer header.");
    }
    const prohibited = trailerNames.filter((k)=>isProhibidedForTrailer(k)
    );
    if (prohibited.length > 0) {
        throw new Deno.errors.InvalidData(`Prohibited trailer names: ${Deno.inspect(prohibited)}.`);
    }
    return new Headers(trailerNames.map((key)=>[
            key,
            ""
        ]
    ));
}
export async function writeChunkedBody(w, r) {
    for await (const chunk of Deno.iter(r)){
        if (chunk.byteLength <= 0) continue;
        const start = encoder.encode(`${chunk.byteLength.toString(16)}\r\n`);
        const end = encoder.encode("\r\n");
        await w.write(start);
        await w.write(chunk);
        await w.write(end);
        await w.flush();
    }
    const endChunk = encoder.encode("0\r\n\r\n");
    await w.write(endChunk);
}
/** Write trailer headers to writer. It should mostly should be called after
 * `writeResponse()`. */ export async function writeTrailers(w, headers, trailers) {
    const trailer = headers.get("trailer");
    if (trailer === null) {
        throw new TypeError("Missing trailer header.");
    }
    const transferEncoding = headers.get("transfer-encoding");
    if (transferEncoding === null || !transferEncoding.match(/^chunked/)) {
        throw new TypeError(`Trailers are only allowed for "transfer-encoding: chunked", got "transfer-encoding: ${transferEncoding}".`);
    }
    const writer = BufWriter.create(w);
    const trailerNames = trailer.split(",").map((s)=>s.trim().toLowerCase()
    );
    const prohibitedTrailers = trailerNames.filter((k)=>isProhibidedForTrailer(k)
    );
    if (prohibitedTrailers.length > 0) {
        throw new TypeError(`Prohibited trailer names: ${Deno.inspect(prohibitedTrailers)}.`);
    }
    const undeclared = [
        ...trailers.keys()
    ].filter((k)=>!trailerNames.includes(k)
    );
    if (undeclared.length > 0) {
        throw new TypeError(`Undeclared trailers: ${Deno.inspect(undeclared)}.`);
    }
    for (const [key, value] of trailers){
        await writer.write(encoder.encode(`${key}: ${value}\r\n`));
    }
    await writer.write(encoder.encode("\r\n"));
    await writer.flush();
}
export async function writeResponse(w, r) {
    const protoMajor = 1;
    const protoMinor = 1;
    const statusCode = r.status || 200;
    const statusText = STATUS_TEXT.get(statusCode);
    const writer = BufWriter.create(w);
    if (!statusText) {
        throw new Deno.errors.InvalidData("Bad status code");
    }
    if (!r.body) {
        r.body = new Uint8Array();
    }
    if (typeof r.body === "string") {
        r.body = encoder.encode(r.body);
    }
    let out = `HTTP/${protoMajor}.${protoMinor} ${statusCode} ${statusText}\r\n`;
    const headers = r.headers ?? new Headers();
    if (r.body && !headers.get("content-length")) {
        if (r.body instanceof Uint8Array) {
            out += `content-length: ${r.body.byteLength}\r\n`;
        } else if (!headers.get("transfer-encoding")) {
            out += "transfer-encoding: chunked\r\n";
        }
    }
    for (const [key, value] of headers){
        out += `${key}: ${value}\r\n`;
    }
    out += `\r\n`;
    const header = encoder.encode(out);
    const n = await writer.write(header);
    assert(n === header.byteLength);
    if (r.body instanceof Uint8Array) {
        const n = await writer.write(r.body);
        assert(n === r.body.byteLength);
    } else if (headers.has("content-length")) {
        const contentLength = headers.get("content-length");
        assert(contentLength != null);
        const bodyLength = parseInt(contentLength);
        const n = await Deno.copy(r.body, writer);
        assert(n === bodyLength);
    } else {
        await writeChunkedBody(writer, r.body);
    }
    if (r.trailers) {
        const t = await r.trailers();
        await writeTrailers(writer, headers, t);
    }
    await writer.flush();
}
/**
 * ParseHTTPVersion parses a HTTP version string.
 * "HTTP/1.0" returns (1, 0).
 * Ported from https://github.com/golang/go/blob/f5c43b9/src/net/http/request.go#L766-L792
 */ export function parseHTTPVersion(vers) {
    switch(vers){
        case "HTTP/1.1":
            return [
                1,
                1
            ];
        case "HTTP/1.0":
            return [
                1,
                0
            ];
        default:
            {
                const Big = 1000000; // arbitrary upper bound
                if (!vers.startsWith("HTTP/")) {
                    break;
                }
                const dot = vers.indexOf(".");
                if (dot < 0) {
                    break;
                }
                const majorStr = vers.substring(vers.indexOf("/") + 1, dot);
                const major = Number(majorStr);
                if (!Number.isInteger(major) || major < 0 || major > Big) {
                    break;
                }
                const minorStr = vers.substring(dot + 1);
                const minor = Number(minorStr);
                if (!Number.isInteger(minor) || minor < 0 || minor > Big) {
                    break;
                }
                return [
                    major,
                    minor
                ];
            }
    }
    throw new Error(`malformed HTTP version ${vers}`);
}
export async function readRequest(conn, bufr) {
    const tp = new TextProtoReader(bufr);
    const firstLine = await tp.readLine(); // e.g. GET /index.html HTTP/1.0
    if (firstLine === null) return null;
    const headers = await tp.readMIMEHeader();
    if (headers === null) throw new Deno.errors.UnexpectedEof();
    const req = new ServerRequest();
    req.conn = conn;
    req.r = bufr;
    [req.method, req.url, req.proto] = firstLine.split(" ", 3);
    [req.protoMajor, req.protoMinor] = parseHTTPVersion(req.proto);
    req.headers = headers;
    fixLength(req);
    return req;
}
function fixLength(req) {
    const contentLength = req.headers.get("Content-Length");
    if (contentLength) {
        const arrClen = contentLength.split(",");
        if (arrClen.length > 1) {
            const distinct = [
                ...new Set(arrClen.map((e)=>e.trim()
                ))
            ];
            if (distinct.length > 1) {
                throw Error("cannot contain multiple Content-Length headers");
            } else {
                req.headers.set("Content-Length", distinct[0]);
            }
        }
        const c = req.headers.get("Content-Length");
        if (req.method === "HEAD" && c && c !== "0") {
            throw Error("http: method cannot contain a Content-Length");
        }
        if (c && req.headers.has("transfer-encoding")) {
            // A sender MUST NOT send a Content-Length header field in any message
            // that contains a Transfer-Encoding header field.
            // rfc: https://tools.ietf.org/html/rfc7230#section-3.3.2
            throw new Error("http: Transfer-Encoding and Content-Length cannot be send together");
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIjxodHRwczovL2Rlbm8ubGFuZC9zdGRAMC44NC4wL2h0dHAvX2lvLnRzPiJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDIxIHRoZSBEZW5vIGF1dGhvcnMuIEFsbCByaWdodHMgcmVzZXJ2ZWQuIE1JVCBsaWNlbnNlLlxuaW1wb3J0IHsgQnVmUmVhZGVyLCBCdWZXcml0ZXIgfSBmcm9tIFwiLi4vaW8vYnVmaW8udHNcIjtcbmltcG9ydCB7IFRleHRQcm90b1JlYWRlciB9IGZyb20gXCIuLi90ZXh0cHJvdG8vbW9kLnRzXCI7XG5pbXBvcnQgeyBhc3NlcnQgfSBmcm9tIFwiLi4vX3V0aWwvYXNzZXJ0LnRzXCI7XG5pbXBvcnQgeyBlbmNvZGVyIH0gZnJvbSBcIi4uL2VuY29kaW5nL3V0ZjgudHNcIjtcbmltcG9ydCB7IFJlc3BvbnNlLCBTZXJ2ZXJSZXF1ZXN0IH0gZnJvbSBcIi4vc2VydmVyLnRzXCI7XG5pbXBvcnQgeyBTVEFUVVNfVEVYVCB9IGZyb20gXCIuL2h0dHBfc3RhdHVzLnRzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBlbXB0eVJlYWRlcigpOiBEZW5vLlJlYWRlciB7XG4gIHJldHVybiB7XG4gICAgcmVhZChfOiBVaW50OEFycmF5KTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKG51bGwpO1xuICAgIH0sXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBib2R5UmVhZGVyKGNvbnRlbnRMZW5ndGg6IG51bWJlciwgcjogQnVmUmVhZGVyKTogRGVuby5SZWFkZXIge1xuICBsZXQgdG90YWxSZWFkID0gMDtcbiAgbGV0IGZpbmlzaGVkID0gZmFsc2U7XG4gIGFzeW5jIGZ1bmN0aW9uIHJlYWQoYnVmOiBVaW50OEFycmF5KTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gICAgaWYgKGZpbmlzaGVkKSByZXR1cm4gbnVsbDtcbiAgICBsZXQgcmVzdWx0OiBudW1iZXIgfCBudWxsO1xuICAgIGNvbnN0IHJlbWFpbmluZyA9IGNvbnRlbnRMZW5ndGggLSB0b3RhbFJlYWQ7XG4gICAgaWYgKHJlbWFpbmluZyA+PSBidWYuYnl0ZUxlbmd0aCkge1xuICAgICAgcmVzdWx0ID0gYXdhaXQgci5yZWFkKGJ1Zik7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHJlYWRCdWYgPSBidWYuc3ViYXJyYXkoMCwgcmVtYWluaW5nKTtcbiAgICAgIHJlc3VsdCA9IGF3YWl0IHIucmVhZChyZWFkQnVmKTtcbiAgICB9XG4gICAgaWYgKHJlc3VsdCAhPT0gbnVsbCkge1xuICAgICAgdG90YWxSZWFkICs9IHJlc3VsdDtcbiAgICB9XG4gICAgZmluaXNoZWQgPSB0b3RhbFJlYWQgPT09IGNvbnRlbnRMZW5ndGg7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuICByZXR1cm4geyByZWFkIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjaHVua2VkQm9keVJlYWRlcihoOiBIZWFkZXJzLCByOiBCdWZSZWFkZXIpOiBEZW5vLlJlYWRlciB7XG4gIC8vIEJhc2VkIG9uIGh0dHBzOi8vdG9vbHMuaWV0Zi5vcmcvaHRtbC9yZmMyNjE2I3NlY3Rpb24tMTkuNC42XG4gIGNvbnN0IHRwID0gbmV3IFRleHRQcm90b1JlYWRlcihyKTtcbiAgbGV0IGZpbmlzaGVkID0gZmFsc2U7XG4gIGNvbnN0IGNodW5rczogQXJyYXk8e1xuICAgIG9mZnNldDogbnVtYmVyO1xuICAgIGRhdGE6IFVpbnQ4QXJyYXk7XG4gIH0+ID0gW107XG4gIGFzeW5jIGZ1bmN0aW9uIHJlYWQoYnVmOiBVaW50OEFycmF5KTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gICAgaWYgKGZpbmlzaGVkKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBbY2h1bmtdID0gY2h1bmtzO1xuICAgIGlmIChjaHVuaykge1xuICAgICAgY29uc3QgY2h1bmtSZW1haW5pbmcgPSBjaHVuay5kYXRhLmJ5dGVMZW5ndGggLSBjaHVuay5vZmZzZXQ7XG4gICAgICBjb25zdCByZWFkTGVuZ3RoID0gTWF0aC5taW4oY2h1bmtSZW1haW5pbmcsIGJ1Zi5ieXRlTGVuZ3RoKTtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcmVhZExlbmd0aDsgaSsrKSB7XG4gICAgICAgIGJ1ZltpXSA9IGNodW5rLmRhdGFbY2h1bmsub2Zmc2V0ICsgaV07XG4gICAgICB9XG4gICAgICBjaHVuay5vZmZzZXQgKz0gcmVhZExlbmd0aDtcbiAgICAgIGlmIChjaHVuay5vZmZzZXQgPT09IGNodW5rLmRhdGEuYnl0ZUxlbmd0aCkge1xuICAgICAgICBjaHVua3Muc2hpZnQoKTtcbiAgICAgICAgLy8gQ29uc3VtZSBcXHJcXG47XG4gICAgICAgIGlmICgoYXdhaXQgdHAucmVhZExpbmUoKSkgPT09IG51bGwpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRGVuby5lcnJvcnMuVW5leHBlY3RlZEVvZigpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gcmVhZExlbmd0aDtcbiAgICB9XG4gICAgY29uc3QgbGluZSA9IGF3YWl0IHRwLnJlYWRMaW5lKCk7XG4gICAgaWYgKGxpbmUgPT09IG51bGwpIHRocm93IG5ldyBEZW5vLmVycm9ycy5VbmV4cGVjdGVkRW9mKCk7XG4gICAgLy8gVE9ETyhiYXJ0bG9taWVqdSk6IGhhbmRsZSBjaHVuayBleHRlbnNpb25cbiAgICBjb25zdCBbY2h1bmtTaXplU3RyaW5nXSA9IGxpbmUuc3BsaXQoXCI7XCIpO1xuICAgIGNvbnN0IGNodW5rU2l6ZSA9IHBhcnNlSW50KGNodW5rU2l6ZVN0cmluZywgMTYpO1xuICAgIGlmIChOdW1iZXIuaXNOYU4oY2h1bmtTaXplKSB8fCBjaHVua1NpemUgPCAwKSB7XG4gICAgICB0aHJvdyBuZXcgRGVuby5lcnJvcnMuSW52YWxpZERhdGEoXCJJbnZhbGlkIGNodW5rIHNpemVcIik7XG4gICAgfVxuICAgIGlmIChjaHVua1NpemUgPiAwKSB7XG4gICAgICBpZiAoY2h1bmtTaXplID4gYnVmLmJ5dGVMZW5ndGgpIHtcbiAgICAgICAgbGV0IGVvZiA9IGF3YWl0IHIucmVhZEZ1bGwoYnVmKTtcbiAgICAgICAgaWYgKGVvZiA9PT0gbnVsbCkge1xuICAgICAgICAgIHRocm93IG5ldyBEZW5vLmVycm9ycy5VbmV4cGVjdGVkRW9mKCk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgcmVzdENodW5rID0gbmV3IFVpbnQ4QXJyYXkoY2h1bmtTaXplIC0gYnVmLmJ5dGVMZW5ndGgpO1xuICAgICAgICBlb2YgPSBhd2FpdCByLnJlYWRGdWxsKHJlc3RDaHVuayk7XG4gICAgICAgIGlmIChlb2YgPT09IG51bGwpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRGVuby5lcnJvcnMuVW5leHBlY3RlZEVvZigpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNodW5rcy5wdXNoKHtcbiAgICAgICAgICAgIG9mZnNldDogMCxcbiAgICAgICAgICAgIGRhdGE6IHJlc3RDaHVuayxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gYnVmLmJ5dGVMZW5ndGg7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBidWZUb0ZpbGwgPSBidWYuc3ViYXJyYXkoMCwgY2h1bmtTaXplKTtcbiAgICAgICAgY29uc3QgZW9mID0gYXdhaXQgci5yZWFkRnVsbChidWZUb0ZpbGwpO1xuICAgICAgICBpZiAoZW9mID09PSBudWxsKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IERlbm8uZXJyb3JzLlVuZXhwZWN0ZWRFb2YoKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBDb25zdW1lIFxcclxcblxuICAgICAgICBpZiAoKGF3YWl0IHRwLnJlYWRMaW5lKCkpID09PSBudWxsKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IERlbm8uZXJyb3JzLlVuZXhwZWN0ZWRFb2YoKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gY2h1bmtTaXplO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBhc3NlcnQoY2h1bmtTaXplID09PSAwKTtcbiAgICAgIC8vIENvbnN1bWUgXFxyXFxuXG4gICAgICBpZiAoKGF3YWl0IHIucmVhZExpbmUoKSkgPT09IG51bGwpIHtcbiAgICAgICAgdGhyb3cgbmV3IERlbm8uZXJyb3JzLlVuZXhwZWN0ZWRFb2YoKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHJlYWRUcmFpbGVycyhoLCByKTtcbiAgICAgIGZpbmlzaGVkID0gdHJ1ZTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfVxuICByZXR1cm4geyByZWFkIH07XG59XG5cbmZ1bmN0aW9uIGlzUHJvaGliaWRlZEZvclRyYWlsZXIoa2V5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgcyA9IG5ldyBTZXQoW1widHJhbnNmZXItZW5jb2RpbmdcIiwgXCJjb250ZW50LWxlbmd0aFwiLCBcInRyYWlsZXJcIl0pO1xuICByZXR1cm4gcy5oYXMoa2V5LnRvTG93ZXJDYXNlKCkpO1xufVxuXG4vKiogUmVhZCB0cmFpbGVyIGhlYWRlcnMgZnJvbSByZWFkZXIgYW5kIGFwcGVuZCB2YWx1ZXMgdG8gaGVhZGVycy4gXCJ0cmFpbGVyXCJcbiAqIGZpZWxkIHdpbGwgYmUgZGVsZXRlZC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkVHJhaWxlcnMoXG4gIGhlYWRlcnM6IEhlYWRlcnMsXG4gIHI6IEJ1ZlJlYWRlcixcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0cmFpbGVycyA9IHBhcnNlVHJhaWxlcihoZWFkZXJzLmdldChcInRyYWlsZXJcIikpO1xuICBpZiAodHJhaWxlcnMgPT0gbnVsbCkgcmV0dXJuO1xuICBjb25zdCB0cmFpbGVyTmFtZXMgPSBbLi4udHJhaWxlcnMua2V5cygpXTtcbiAgY29uc3QgdHAgPSBuZXcgVGV4dFByb3RvUmVhZGVyKHIpO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCB0cC5yZWFkTUlNRUhlYWRlcigpO1xuICBpZiAocmVzdWx0ID09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRGVuby5lcnJvcnMuSW52YWxpZERhdGEoXCJNaXNzaW5nIHRyYWlsZXIgaGVhZGVyLlwiKTtcbiAgfVxuICBjb25zdCB1bmRlY2xhcmVkID0gWy4uLnJlc3VsdC5rZXlzKCldLmZpbHRlcihcbiAgICAoaykgPT4gIXRyYWlsZXJOYW1lcy5pbmNsdWRlcyhrKSxcbiAgKTtcbiAgaWYgKHVuZGVjbGFyZWQubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBEZW5vLmVycm9ycy5JbnZhbGlkRGF0YShcbiAgICAgIGBVbmRlY2xhcmVkIHRyYWlsZXJzOiAke0Rlbm8uaW5zcGVjdCh1bmRlY2xhcmVkKX0uYCxcbiAgICApO1xuICB9XG4gIGZvciAoY29uc3QgW2ssIHZdIG9mIHJlc3VsdCkge1xuICAgIGhlYWRlcnMuYXBwZW5kKGssIHYpO1xuICB9XG4gIGNvbnN0IG1pc3NpbmdUcmFpbGVycyA9IHRyYWlsZXJOYW1lcy5maWx0ZXIoKGspID0+ICFyZXN1bHQuaGFzKGspKTtcbiAgaWYgKG1pc3NpbmdUcmFpbGVycy5sZW5ndGggPiAwKSB7XG4gICAgdGhyb3cgbmV3IERlbm8uZXJyb3JzLkludmFsaWREYXRhKFxuICAgICAgYE1pc3NpbmcgdHJhaWxlcnM6ICR7RGVuby5pbnNwZWN0KG1pc3NpbmdUcmFpbGVycyl9LmAsXG4gICAgKTtcbiAgfVxuICBoZWFkZXJzLmRlbGV0ZShcInRyYWlsZXJcIik7XG59XG5cbmZ1bmN0aW9uIHBhcnNlVHJhaWxlcihmaWVsZDogc3RyaW5nIHwgbnVsbCk6IEhlYWRlcnMgfCB1bmRlZmluZWQge1xuICBpZiAoZmllbGQgPT0gbnVsbCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cbiAgY29uc3QgdHJhaWxlck5hbWVzID0gZmllbGQuc3BsaXQoXCIsXCIpLm1hcCgodikgPT4gdi50cmltKCkudG9Mb3dlckNhc2UoKSk7XG4gIGlmICh0cmFpbGVyTmFtZXMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IERlbm8uZXJyb3JzLkludmFsaWREYXRhKFwiRW1wdHkgdHJhaWxlciBoZWFkZXIuXCIpO1xuICB9XG4gIGNvbnN0IHByb2hpYml0ZWQgPSB0cmFpbGVyTmFtZXMuZmlsdGVyKChrKSA9PiBpc1Byb2hpYmlkZWRGb3JUcmFpbGVyKGspKTtcbiAgaWYgKHByb2hpYml0ZWQubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBEZW5vLmVycm9ycy5JbnZhbGlkRGF0YShcbiAgICAgIGBQcm9oaWJpdGVkIHRyYWlsZXIgbmFtZXM6ICR7RGVuby5pbnNwZWN0KHByb2hpYml0ZWQpfS5gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG5ldyBIZWFkZXJzKHRyYWlsZXJOYW1lcy5tYXAoKGtleSkgPT4gW2tleSwgXCJcIl0pKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdyaXRlQ2h1bmtlZEJvZHkoXG4gIHc6IEJ1ZldyaXRlcixcbiAgcjogRGVuby5SZWFkZXIsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgZm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiBEZW5vLml0ZXIocikpIHtcbiAgICBpZiAoY2h1bmsuYnl0ZUxlbmd0aCA8PSAwKSBjb250aW51ZTtcbiAgICBjb25zdCBzdGFydCA9IGVuY29kZXIuZW5jb2RlKGAke2NodW5rLmJ5dGVMZW5ndGgudG9TdHJpbmcoMTYpfVxcclxcbmApO1xuICAgIGNvbnN0IGVuZCA9IGVuY29kZXIuZW5jb2RlKFwiXFxyXFxuXCIpO1xuICAgIGF3YWl0IHcud3JpdGUoc3RhcnQpO1xuICAgIGF3YWl0IHcud3JpdGUoY2h1bmspO1xuICAgIGF3YWl0IHcud3JpdGUoZW5kKTtcbiAgICBhd2FpdCB3LmZsdXNoKCk7XG4gIH1cblxuICBjb25zdCBlbmRDaHVuayA9IGVuY29kZXIuZW5jb2RlKFwiMFxcclxcblxcclxcblwiKTtcbiAgYXdhaXQgdy53cml0ZShlbmRDaHVuayk7XG59XG5cbi8qKiBXcml0ZSB0cmFpbGVyIGhlYWRlcnMgdG8gd3JpdGVyLiBJdCBzaG91bGQgbW9zdGx5IHNob3VsZCBiZSBjYWxsZWQgYWZ0ZXJcbiAqIGB3cml0ZVJlc3BvbnNlKClgLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdyaXRlVHJhaWxlcnMoXG4gIHc6IERlbm8uV3JpdGVyLFxuICBoZWFkZXJzOiBIZWFkZXJzLFxuICB0cmFpbGVyczogSGVhZGVycyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0cmFpbGVyID0gaGVhZGVycy5nZXQoXCJ0cmFpbGVyXCIpO1xuICBpZiAodHJhaWxlciA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXCJNaXNzaW5nIHRyYWlsZXIgaGVhZGVyLlwiKTtcbiAgfVxuICBjb25zdCB0cmFuc2ZlckVuY29kaW5nID0gaGVhZGVycy5nZXQoXCJ0cmFuc2Zlci1lbmNvZGluZ1wiKTtcbiAgaWYgKHRyYW5zZmVyRW5jb2RpbmcgPT09IG51bGwgfHwgIXRyYW5zZmVyRW5jb2RpbmcubWF0Y2goL15jaHVua2VkLykpIHtcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFxuICAgICAgYFRyYWlsZXJzIGFyZSBvbmx5IGFsbG93ZWQgZm9yIFwidHJhbnNmZXItZW5jb2Rpbmc6IGNodW5rZWRcIiwgZ290IFwidHJhbnNmZXItZW5jb2Rpbmc6ICR7dHJhbnNmZXJFbmNvZGluZ31cIi5gLFxuICAgICk7XG4gIH1cbiAgY29uc3Qgd3JpdGVyID0gQnVmV3JpdGVyLmNyZWF0ZSh3KTtcbiAgY29uc3QgdHJhaWxlck5hbWVzID0gdHJhaWxlci5zcGxpdChcIixcIikubWFwKChzKSA9PiBzLnRyaW0oKS50b0xvd2VyQ2FzZSgpKTtcbiAgY29uc3QgcHJvaGliaXRlZFRyYWlsZXJzID0gdHJhaWxlck5hbWVzLmZpbHRlcigoaykgPT5cbiAgICBpc1Byb2hpYmlkZWRGb3JUcmFpbGVyKGspXG4gICk7XG4gIGlmIChwcm9oaWJpdGVkVHJhaWxlcnMubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXG4gICAgICBgUHJvaGliaXRlZCB0cmFpbGVyIG5hbWVzOiAke0Rlbm8uaW5zcGVjdChwcm9oaWJpdGVkVHJhaWxlcnMpfS5gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdW5kZWNsYXJlZCA9IFsuLi50cmFpbGVycy5rZXlzKCldLmZpbHRlcihcbiAgICAoaykgPT4gIXRyYWlsZXJOYW1lcy5pbmNsdWRlcyhrKSxcbiAgKTtcbiAgaWYgKHVuZGVjbGFyZWQubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoYFVuZGVjbGFyZWQgdHJhaWxlcnM6ICR7RGVuby5pbnNwZWN0KHVuZGVjbGFyZWQpfS5gKTtcbiAgfVxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiB0cmFpbGVycykge1xuICAgIGF3YWl0IHdyaXRlci53cml0ZShlbmNvZGVyLmVuY29kZShgJHtrZXl9OiAke3ZhbHVlfVxcclxcbmApKTtcbiAgfVxuICBhd2FpdCB3cml0ZXIud3JpdGUoZW5jb2Rlci5lbmNvZGUoXCJcXHJcXG5cIikpO1xuICBhd2FpdCB3cml0ZXIuZmx1c2goKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdyaXRlUmVzcG9uc2UoXG4gIHc6IERlbm8uV3JpdGVyLFxuICByOiBSZXNwb25zZSxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBwcm90b01ham9yID0gMTtcbiAgY29uc3QgcHJvdG9NaW5vciA9IDE7XG4gIGNvbnN0IHN0YXR1c0NvZGUgPSByLnN0YXR1cyB8fCAyMDA7XG4gIGNvbnN0IHN0YXR1c1RleHQgPSBTVEFUVVNfVEVYVC5nZXQoc3RhdHVzQ29kZSk7XG4gIGNvbnN0IHdyaXRlciA9IEJ1ZldyaXRlci5jcmVhdGUodyk7XG4gIGlmICghc3RhdHVzVGV4dCkge1xuICAgIHRocm93IG5ldyBEZW5vLmVycm9ycy5JbnZhbGlkRGF0YShcIkJhZCBzdGF0dXMgY29kZVwiKTtcbiAgfVxuICBpZiAoIXIuYm9keSkge1xuICAgIHIuYm9keSA9IG5ldyBVaW50OEFycmF5KCk7XG4gIH1cbiAgaWYgKHR5cGVvZiByLmJvZHkgPT09IFwic3RyaW5nXCIpIHtcbiAgICByLmJvZHkgPSBlbmNvZGVyLmVuY29kZShyLmJvZHkpO1xuICB9XG5cbiAgbGV0IG91dCA9IGBIVFRQLyR7cHJvdG9NYWpvcn0uJHtwcm90b01pbm9yfSAke3N0YXR1c0NvZGV9ICR7c3RhdHVzVGV4dH1cXHJcXG5gO1xuXG4gIGNvbnN0IGhlYWRlcnMgPSByLmhlYWRlcnMgPz8gbmV3IEhlYWRlcnMoKTtcblxuICBpZiAoci5ib2R5ICYmICFoZWFkZXJzLmdldChcImNvbnRlbnQtbGVuZ3RoXCIpKSB7XG4gICAgaWYgKHIuYm9keSBpbnN0YW5jZW9mIFVpbnQ4QXJyYXkpIHtcbiAgICAgIG91dCArPSBgY29udGVudC1sZW5ndGg6ICR7ci5ib2R5LmJ5dGVMZW5ndGh9XFxyXFxuYDtcbiAgICB9IGVsc2UgaWYgKCFoZWFkZXJzLmdldChcInRyYW5zZmVyLWVuY29kaW5nXCIpKSB7XG4gICAgICBvdXQgKz0gXCJ0cmFuc2Zlci1lbmNvZGluZzogY2h1bmtlZFxcclxcblwiO1xuICAgIH1cbiAgfVxuXG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIGhlYWRlcnMpIHtcbiAgICBvdXQgKz0gYCR7a2V5fTogJHt2YWx1ZX1cXHJcXG5gO1xuICB9XG5cbiAgb3V0ICs9IGBcXHJcXG5gO1xuXG4gIGNvbnN0IGhlYWRlciA9IGVuY29kZXIuZW5jb2RlKG91dCk7XG4gIGNvbnN0IG4gPSBhd2FpdCB3cml0ZXIud3JpdGUoaGVhZGVyKTtcbiAgYXNzZXJ0KG4gPT09IGhlYWRlci5ieXRlTGVuZ3RoKTtcblxuICBpZiAoci5ib2R5IGluc3RhbmNlb2YgVWludDhBcnJheSkge1xuICAgIGNvbnN0IG4gPSBhd2FpdCB3cml0ZXIud3JpdGUoci5ib2R5KTtcbiAgICBhc3NlcnQobiA9PT0gci5ib2R5LmJ5dGVMZW5ndGgpO1xuICB9IGVsc2UgaWYgKGhlYWRlcnMuaGFzKFwiY29udGVudC1sZW5ndGhcIikpIHtcbiAgICBjb25zdCBjb250ZW50TGVuZ3RoID0gaGVhZGVycy5nZXQoXCJjb250ZW50LWxlbmd0aFwiKTtcbiAgICBhc3NlcnQoY29udGVudExlbmd0aCAhPSBudWxsKTtcbiAgICBjb25zdCBib2R5TGVuZ3RoID0gcGFyc2VJbnQoY29udGVudExlbmd0aCk7XG4gICAgY29uc3QgbiA9IGF3YWl0IERlbm8uY29weShyLmJvZHksIHdyaXRlcik7XG4gICAgYXNzZXJ0KG4gPT09IGJvZHlMZW5ndGgpO1xuICB9IGVsc2Uge1xuICAgIGF3YWl0IHdyaXRlQ2h1bmtlZEJvZHkod3JpdGVyLCByLmJvZHkpO1xuICB9XG4gIGlmIChyLnRyYWlsZXJzKSB7XG4gICAgY29uc3QgdCA9IGF3YWl0IHIudHJhaWxlcnMoKTtcbiAgICBhd2FpdCB3cml0ZVRyYWlsZXJzKHdyaXRlciwgaGVhZGVycywgdCk7XG4gIH1cbiAgYXdhaXQgd3JpdGVyLmZsdXNoKCk7XG59XG5cbi8qKlxuICogUGFyc2VIVFRQVmVyc2lvbiBwYXJzZXMgYSBIVFRQIHZlcnNpb24gc3RyaW5nLlxuICogXCJIVFRQLzEuMFwiIHJldHVybnMgKDEsIDApLlxuICogUG9ydGVkIGZyb20gaHR0cHM6Ly9naXRodWIuY29tL2dvbGFuZy9nby9ibG9iL2Y1YzQzYjkvc3JjL25ldC9odHRwL3JlcXVlc3QuZ28jTDc2Ni1MNzkyXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUhUVFBWZXJzaW9uKHZlcnM6IHN0cmluZyk6IFtudW1iZXIsIG51bWJlcl0ge1xuICBzd2l0Y2ggKHZlcnMpIHtcbiAgICBjYXNlIFwiSFRUUC8xLjFcIjpcbiAgICAgIHJldHVybiBbMSwgMV07XG5cbiAgICBjYXNlIFwiSFRUUC8xLjBcIjpcbiAgICAgIHJldHVybiBbMSwgMF07XG5cbiAgICBkZWZhdWx0OiB7XG4gICAgICBjb25zdCBCaWcgPSAxMDAwMDAwOyAvLyBhcmJpdHJhcnkgdXBwZXIgYm91bmRcblxuICAgICAgaWYgKCF2ZXJzLnN0YXJ0c1dpdGgoXCJIVFRQL1wiKSkge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgY29uc3QgZG90ID0gdmVycy5pbmRleE9mKFwiLlwiKTtcbiAgICAgIGlmIChkb3QgPCAwKSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBtYWpvclN0ciA9IHZlcnMuc3Vic3RyaW5nKHZlcnMuaW5kZXhPZihcIi9cIikgKyAxLCBkb3QpO1xuICAgICAgY29uc3QgbWFqb3IgPSBOdW1iZXIobWFqb3JTdHIpO1xuICAgICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKG1ham9yKSB8fCBtYWpvciA8IDAgfHwgbWFqb3IgPiBCaWcpIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IG1pbm9yU3RyID0gdmVycy5zdWJzdHJpbmcoZG90ICsgMSk7XG4gICAgICBjb25zdCBtaW5vciA9IE51bWJlcihtaW5vclN0cik7XG4gICAgICBpZiAoIU51bWJlci5pc0ludGVnZXIobWlub3IpIHx8IG1pbm9yIDwgMCB8fCBtaW5vciA+IEJpZykge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIFttYWpvciwgbWlub3JdO1xuICAgIH1cbiAgfVxuXG4gIHRocm93IG5ldyBFcnJvcihgbWFsZm9ybWVkIEhUVFAgdmVyc2lvbiAke3ZlcnN9YCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZWFkUmVxdWVzdChcbiAgY29ubjogRGVuby5Db25uLFxuICBidWZyOiBCdWZSZWFkZXIsXG4pOiBQcm9taXNlPFNlcnZlclJlcXVlc3QgfCBudWxsPiB7XG4gIGNvbnN0IHRwID0gbmV3IFRleHRQcm90b1JlYWRlcihidWZyKTtcbiAgY29uc3QgZmlyc3RMaW5lID0gYXdhaXQgdHAucmVhZExpbmUoKTsgLy8gZS5nLiBHRVQgL2luZGV4Lmh0bWwgSFRUUC8xLjBcbiAgaWYgKGZpcnN0TGluZSA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGhlYWRlcnMgPSBhd2FpdCB0cC5yZWFkTUlNRUhlYWRlcigpO1xuICBpZiAoaGVhZGVycyA9PT0gbnVsbCkgdGhyb3cgbmV3IERlbm8uZXJyb3JzLlVuZXhwZWN0ZWRFb2YoKTtcblxuICBjb25zdCByZXEgPSBuZXcgU2VydmVyUmVxdWVzdCgpO1xuICByZXEuY29ubiA9IGNvbm47XG4gIHJlcS5yID0gYnVmcjtcbiAgW3JlcS5tZXRob2QsIHJlcS51cmwsIHJlcS5wcm90b10gPSBmaXJzdExpbmUuc3BsaXQoXCIgXCIsIDMpO1xuICBbcmVxLnByb3RvTWFqb3IsIHJlcS5wcm90b01pbm9yXSA9IHBhcnNlSFRUUFZlcnNpb24ocmVxLnByb3RvKTtcbiAgcmVxLmhlYWRlcnMgPSBoZWFkZXJzO1xuICBmaXhMZW5ndGgocmVxKTtcbiAgcmV0dXJuIHJlcTtcbn1cblxuZnVuY3Rpb24gZml4TGVuZ3RoKHJlcTogU2VydmVyUmVxdWVzdCk6IHZvaWQge1xuICBjb25zdCBjb250ZW50TGVuZ3RoID0gcmVxLmhlYWRlcnMuZ2V0KFwiQ29udGVudC1MZW5ndGhcIik7XG4gIGlmIChjb250ZW50TGVuZ3RoKSB7XG4gICAgY29uc3QgYXJyQ2xlbiA9IGNvbnRlbnRMZW5ndGguc3BsaXQoXCIsXCIpO1xuICAgIGlmIChhcnJDbGVuLmxlbmd0aCA+IDEpIHtcbiAgICAgIGNvbnN0IGRpc3RpbmN0ID0gWy4uLm5ldyBTZXQoYXJyQ2xlbi5tYXAoKGUpOiBzdHJpbmcgPT4gZS50cmltKCkpKV07XG4gICAgICBpZiAoZGlzdGluY3QubGVuZ3RoID4gMSkge1xuICAgICAgICB0aHJvdyBFcnJvcihcImNhbm5vdCBjb250YWluIG11bHRpcGxlIENvbnRlbnQtTGVuZ3RoIGhlYWRlcnNcIik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXEuaGVhZGVycy5zZXQoXCJDb250ZW50LUxlbmd0aFwiLCBkaXN0aW5jdFswXSk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGMgPSByZXEuaGVhZGVycy5nZXQoXCJDb250ZW50LUxlbmd0aFwiKTtcbiAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJIRUFEXCIgJiYgYyAmJiBjICE9PSBcIjBcIikge1xuICAgICAgdGhyb3cgRXJyb3IoXCJodHRwOiBtZXRob2QgY2Fubm90IGNvbnRhaW4gYSBDb250ZW50LUxlbmd0aFwiKTtcbiAgICB9XG4gICAgaWYgKGMgJiYgcmVxLmhlYWRlcnMuaGFzKFwidHJhbnNmZXItZW5jb2RpbmdcIikpIHtcbiAgICAgIC8vIEEgc2VuZGVyIE1VU1QgTk9UIHNlbmQgYSBDb250ZW50LUxlbmd0aCBoZWFkZXIgZmllbGQgaW4gYW55IG1lc3NhZ2VcbiAgICAgIC8vIHRoYXQgY29udGFpbnMgYSBUcmFuc2Zlci1FbmNvZGluZyBoZWFkZXIgZmllbGQuXG4gICAgICAvLyByZmM6IGh0dHBzOi8vdG9vbHMuaWV0Zi5vcmcvaHRtbC9yZmM3MjMwI3NlY3Rpb24tMy4zLjJcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJodHRwOiBUcmFuc2Zlci1FbmNvZGluZyBhbmQgQ29udGVudC1MZW5ndGggY2Fubm90IGJlIHNlbmQgdG9nZXRoZXJcIixcbiAgICAgICk7XG4gICAgfVxuICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsRUFBQSx3RUFBQTtTQUNBLFNBQUEsU0FBQSxjQUFBO1NBQ0EsZUFBQSxTQUFBLG1CQUFBO1NBQ0EsTUFBQSxTQUFBLGtCQUFBO1NBQ0EsT0FBQSxTQUFBLG1CQUFBO1NBQ0EsYUFBQSxTQUFBLFdBQUE7U0FDQSxXQUFBLFNBQUEsZ0JBQUE7Z0JBRUEsV0FBQTs7QUFFQSxZQUFBLEVBQUEsQ0FBQTttQkFDQSxPQUFBLENBQUEsT0FBQSxDQUFBLElBQUE7Ozs7Z0JBS0EsVUFBQSxDQUFBLGFBQUEsRUFBQSxDQUFBO1FBQ0EsU0FBQSxHQUFBLENBQUE7UUFDQSxRQUFBLEdBQUEsS0FBQTttQkFDQSxJQUFBLENBQUEsR0FBQTtZQUNBLFFBQUEsU0FBQSxJQUFBO1lBQ0EsTUFBQTtjQUNBLFNBQUEsR0FBQSxhQUFBLEdBQUEsU0FBQTtZQUNBLFNBQUEsSUFBQSxHQUFBLENBQUEsVUFB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QUEsT0FBQSxJQUFBOzBCQUNBLElBQUEsQ0FBQSxNQUFBLENBQUEsYUFBQTs7a0JBRUEsWUFBQSxDQUFBLENBQUEsRUFBQSxDQUFBO0FBQ0Esb0JBQUEsR0FBQSxJQUFBO21CQUNBLElBQUE7Ozs7QUFHQSxZQUFBOzs7U0FHQSxzQkFBQSxDQUFBLEdBQUE7VUFDQSxDQUFBLE9BQUEsR0FBQTtTQUFBLGlCQUFBO1NBQUEsY0FBQTtTQUFBLE9BQUE7O1dBQ0EsQ0FBQSxDQUFBLEdBQUEsQ0FBQSxHQUFBLENBQUEsV0FBQTs7QUFHQSxFQUNBLEFBREEscUdBQ0EsQUFEQSxFQUNBLHVCQUNBLFlBQUEsQ0FDQSxPQUFBLEVBQ0EsQ0FBQTtVQUVBLFFBQUEsR0FBQSxZQUFBLENBQUEsT0FBQSxDQUFBLEdBQUEsRUFBQSxPQUFBO1FBQ0EsUUFBQSxJQUFBLElBQUE7VUFDQSxZQUFBO1dBQUEsUUFBQSxDQUFBLElBQUE7O1VBQ0EsRUFBQSxPQUFBLGVBQUEsQ0FBQSxDQUFBO1VBQ0EsTUFBQSxTQUFBLEVBQUEsQ0FBQSxjQUFBO1FBQ0EsTUFBQSxJQUFBLElBQUE7a0JBQ0EsSUFBQSxDQUFBLE1BQUEsQ0FBQSxXQUFBLEVBQUEsdUJBQUE7O1VBRUEsVUFBQTtXQUFBLE1BQUEsQ0FBQSxJQUFBO01BQUEsTUFBQSxFQUNBLENBQUEsSUFBQSxZQUFBLENBQUEsUUFBQSxDQUFBLENBQUE7O1FBRUEsVUFBQSxDQUFBLE1BQUEsR0FBQSxDQUFBO2tCQUNBLElBQUEsQ0FBQSxNQUFBLENBQUEsV0FBQSxFQUNBLHFCQUFBLEVBQUEsSUFBQSxDQUFBLE9BQUEsQ0FBQSxVQUFBLEVBQUEsQ0FBQTs7Z0JBR0EsQ0FBQSxFQUFBLENBQUEsS0FBQSxNQUFBO0FBQ0EsZUFBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBLEVBQUEsQ0FBQTs7VUFFQSxlQUFBLEdBQUEsWUFBQSxDQUFBLE1BQUEsRUFBQSxDQUFBLElBQUEsTUFBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBOztRQUNBLGVBQUEsQ0FBQSxNQUFBLEdBQUEsQ0FBQTtrQkFDQSxJQUFBLENBQUEsTUFBQSxDQUFBLFdBQUEsRUFDQSxrQkFBQSxFQUFBLElBQUEsQ0FBQSxPQUFBLENBQUEsZUFBQSxFQUFBLENBQUE7O0FBR0EsV0FBQSxDQUFBLE1BQUEsRUFBQSxPQUFBOztTQUdBLFlBQUEsQ0FBQSxLQUFBO1FBQ0EsS0FBQSxJQUFBLElBQUE7ZUFDQSxTQUFBOztVQUVBLFlBQUEsR0FBQSxLQUFBLENBQUEsS0FBQSxFQUFBLENBQUEsR0FBQSxHQUFBLEVBQUEsQ0FBQSxHQUFBLENBQUEsQ0FBQSxJQUFBLEdBQUEsV0FBQTs7UUFDQSxZQUFBLENBQUEsTUFBQSxLQUFBLENBQUE7a0JBQ0EsSUFBQSxDQUFBLE1BQUEsQ0FBQSxXQUFBLEVBQUEscUJBQUE7O1VBRUEsVUFBQSxHQUFBLFlBQUEsQ0FBQSxNQUFBLEVBQUEsQ0FBQSxHQUFBLHNCQUFBLENBQUEsQ0FBQTs7UUFDQSxVQUFBLENBQUEsTUFBQSxHQUFBLENBQUE7a0JBQ0EsSUFBQSxDQUFBLE1BQUEsQ0FBQSxXQUFBLEVBQ0EsMEJBQUEsRUFBQSxJQUFBLENBQUEsT0FBQSxDQUFBLFVBQUEsRUFBQSxDQUFBOztlQUdBLE9BQUEsQ0FBQSxZQUFBLENBQUEsR0FBQSxFQUFBLEdBQUE7QUFBQSxlQUFBOzs7OztzQkFHQSxnQkFBQSxDQUNBLENBQUEsRUFDQSxDQUFBO3FCQUVBLEtBQUEsSUFBQSxJQUFBLENBQUEsSUFBQSxDQUFBLENBQUE7WUFDQSxLQUFBLENBQUEsVUFBQSxJQUFBLENBQUE7Y0FDQSxLQUFBLEdBQUEsT0FBQSxDQUFBLE1BQUEsSUFBQSxLQUFBLENBQUEsVUFBQSxDQUFBLFFBQUEsQ0FBQSxFQUFBLEVBQUEsSUFBQTtjQUNBLEdBQUEsR0FBQSxPQUFBLENBQUEsTUFBQSxFQUFBLElBQUE7Y0FDQSxDQUFBLENBQUEsS0FBQSxDQUFBLEtBQUE7Y0FDQSxDQUFBLENBQUEsS0FBQSxDQUFBLEtBQUE7Y0FDQSxDQUFBLENBQUEsS0FBQSxDQUFBLEdBQUE7Y0FDQSxDQUFBLENBQUEsS0FBQTs7VUFHQSxRQUFBLEdBQUEsT0FBQSxDQUFBLE1BQUEsRUFBQSxTQUFBO1VBQ0EsQ0FBQSxDQUFBLEtBQUEsQ0FBQSxRQUFBOztBQUdBLEVBQ0EsQUFEQSxpR0FDQSxBQURBLEVBQ0EsdUJBQ0EsYUFBQSxDQUNBLENBQUEsRUFDQSxPQUFBLEVBQ0EsUUFBQTtVQUVBLE9BQUEsR0FBQSxPQUFBLENBQUEsR0FBQSxFQUFBLE9BQUE7UUFDQSxPQUFBLEtBQUEsSUFBQTtrQkFDQSxTQUFBLEVBQUEsdUJBQUE7O1VBRUEsZ0JBQUEsR0FBQSxPQUFBLENBQUEsR0FBQSxFQUFBLGlCQUFBO1FBQ0EsZ0JBQUEsS0FBQSxJQUFBLEtBQUEsZ0JBQUEsQ0FBQSxLQUFBO2tCQUNBLFNBQUEsRUFDQSxvRkFBQSxFQUFBLGdCQUFBLENBQUEsRUFBQTs7VUFHQSxNQUFBLEdBQUEsU0FBQSxDQUFBLE1BQUEsQ0FBQSxDQUFBO1VBQ0EsWUFBQSxHQUFBLE9BQUEsQ0FBQSxLQUFBLEVBQUEsQ0FBQSxHQUFBLEdBQUEsRUFBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLElBQUEsR0FBQSxXQUFBOztVQUNBLGtCQUFBLEdBQUEsWUFBQSxDQUFBLE1BQUEsRUFBQSxDQUFBLEdBQ0Esc0JBQUEsQ0FBQSxDQUFBOztRQUVBLGtCQUFBLENBQUEsTUFBQSxHQUFBLENBQUE7a0JBQ0EsU0FBQSxFQUNBLDBCQUFBLEVBQUEsSUFBQSxDQUFBLE9BQUEsQ0FBQSxrQkFBQSxFQUFBLENBQUE7O1VBR0EsVUFBQTtXQUFBLFFBQUEsQ0FBQSxJQUFBO01BQUEsTUFBQSxFQUNBLENBQUEsSUFBQSxZQUFBLENBQUEsUUFBQSxDQUFBLENBQUE7O1FBRUEsVUFBQSxDQUFBLE1BQUEsR0FBQSxDQUFBO2tCQUNBLFNBQUEsRUFBQSxxQkFBQSxFQUFBLElBQUEsQ0FBQSxPQUFBLENBQUEsVUFBQSxFQUFBLENBQUE7O2dCQUVBLEdBQUEsRUFBQSxLQUFBLEtBQUEsUUFBQTtjQUNBLE1BQUEsQ0FBQSxLQUFBLENBQUEsT0FBQSxDQUFBLE1BQUEsSUFBQSxHQUFBLENBQUEsRUFBQSxFQUFBLEtBQUEsQ0FBQSxJQUFBOztVQUVBLE1BQUEsQ0FBQSxLQUFBLENBQUEsT0FBQSxDQUFBLE1BQUEsRUFBQSxJQUFBO1VBQ0EsTUFBQSxDQUFBLEtBQUE7O3NCQUdBLGFBQUEsQ0FDQSxDQUFBLEVBQ0EsQ0FBQTtVQUVBLFVBQUEsR0FBQSxDQUFBO1VBQ0EsVUFBQSxHQUFBLENBQUE7VUFDQSxVQUFBLEdBQUEsQ0FBQSxDQUFBLE1BQUEsSUFBQSxHQUFBO1VBQ0EsVUFBQSxHQUFBLFdBQUEsQ0FBQSxHQUFBLENBQUEsVUFBQTtVQUNBLE1BQUEsR0FBQSxTQUFBLENBQUEsTUFBQSxDQUFBLENBQUE7U0FDQSxVQUFBO2tCQUNBLElBQUEsQ0FBQSxNQUFBLENBQUEsV0FBQSxFQUFBLGVBQUE7O1NBRUEsQ0FBQSxDQUFBLElBQUE7QUFDQSxTQUFBLENBQUEsSUFBQSxPQUFBLFVBQUE7O2VBRUEsQ0FBQSxDQUFBLElBQUEsTUFBQSxNQUFBO0FBQ0EsU0FBQSxDQUFBLElBQUEsR0FBQSxPQUFBLENBQUEsTUFBQSxDQUFBLENBQUEsQ0FBQSxJQUFBOztRQUdBLEdBQUEsSUFBQSxLQUFBLEVBQUEsVUFBQSxDQUFBLENBQUEsRUFBQSxVQUFBLENBQUEsQ0FBQSxFQUFBLFVBQUEsQ0FBQSxDQUFBLEVBQUEsVUFBQSxDQUFBLElBQUE7VUFFQSxPQUFBLEdBQUEsQ0FBQSxDQUFBLE9BQUEsUUFBQSxPQUFBO1FBRUEsQ0FBQSxDQUFBLElBQUEsS0FBQSxPQUFBLENBQUEsR0FBQSxFQUFBLGNBQUE7WUFDQSxDQUFBLENBQUEsSUFBQSxZQUFBLFVBQUE7QUFDQSxlQUFBLEtBQUEsZ0JBQUEsRUFBQSxDQUFBLENBQUEsSUFBQSxDQUFBLFVBQUEsQ0FBQSxJQUFBO29CQUNBLE9BQUEsQ0FBQSxHQUFBLEVBQUEsaUJBQUE7QUFDQSxlQUFBLEtBQUEsOEJBQUE7OztnQkFJQSxHQUFBLEVBQUEsS0FBQSxLQUFBLE9BQUE7QUFDQSxXQUFBLE9BQUEsR0FBQSxDQUFBLEVBQUEsRUFBQSxLQUFBLENBQUEsSUFBQTs7QUFHQSxPQUFBLEtBQUEsSUFBQTtVQUVBLE1BQUEsR0FBQSxPQUFBLENBQUEsTUFBQSxDQUFBLEdBQUE7VUFDQSxDQUFBLFNBQUEsTUFBQSxDQUFBLEtBQUEsQ0FBQSxNQUFBO0FBQ0EsVUFBQSxDQUFBLENBQUEsS0FBQSxNQUFBLENBQUEsVUFBQTtRQUVBLENBQUEsQ0FBQSxJQUFBLFlBQUEsVUFBQTtjQUNBLENBQUEsU0FBQSxNQUFBLENBQUEsS0FBQSxDQUFBLENBQUEsQ0FBQSxJQUFBO0FBQ0EsY0FBQSxDQUFBLENBQUEsS0FBQSxDQUFBLENBQUEsSUFBQSxDQUFBLFVBQUE7ZUFDQSxPQUFBLENBQUEsR0FBQSxFQUFBLGNBQUE7Y0FDQSxhQUFBLEdBQUEsT0FBQSxDQUFBLEdBQUEsRUFBQSxjQUFBO0FBQ0EsY0FBQSxDQUFBLGFBQUEsSUFBQSxJQUFBO2NBQ0EsVUFBQSxHQUFBLFFBQUEsQ0FBQSxhQUFBO2NBQ0EsQ0FBQSxTQUFBLElBQUEsQ0FBQSxJQUFBLENBQUEsQ0FBQSxDQUFBLElBQUEsRUFBQSxNQUFBO0FBQ0EsY0FBQSxDQUFBLENBQUEsS0FBQSxVQUFBOztjQUVBLGdCQUFBLENBQUEsTUFBQSxFQUFBLENBQUEsQ0FBQSxJQUFBOztRQUVBLENBQUEsQ0FBQSxRQUFBO2NBQ0EsQ0FBQSxTQUFBLENBQUEsQ0FBQSxRQUFBO2NBQ0EsYUFBQSxDQUFBLE1BQUEsRUFBQSxPQUFBLEVBQUEsQ0FBQTs7VUFFQSxNQUFBLENBQUEsS0FBQTs7QUFHQSxFQUlBLEFBSkEsOEtBSUEsQUFKQSxFQUlBLGlCQUNBLGdCQUFBLENBQUEsSUFBQTtXQUNBLElBQUE7Y0FDQSxRQUFBOztBQUNBLGlCQUFBO0FBQUEsaUJBQUE7O2NBRUEsUUFBQTs7QUFDQSxpQkFBQTtBQUFBLGlCQUFBOzs7O3NCQUdBLEdBQUEsR0FBQSxPQUFBLENBQUEsQ0FBQSxFQUFBLHNCQUFBO3FCQUVBLElBQUEsQ0FBQSxVQUFBLEVBQUEsS0FBQTs7O3NCQUlBLEdBQUEsR0FBQSxJQUFBLENBQUEsT0FBQSxFQUFBLENBQUE7b0JBQ0EsR0FBQSxHQUFBLENBQUE7OztzQkFJQSxRQUFBLEdBQUEsSUFBQSxDQUFBLFNBQUEsQ0FBQSxJQUFBLENBQUEsT0FBQSxFQUFBLENBQUEsS0FBQSxDQUFBLEVBQUEsR0FBQTtzQkFDQSxLQUFBLEdBQUEsTUFBQSxDQUFBLFFBQUE7cUJBQ0EsTUFBQSxDQUFBLFNBQUEsQ0FBQSxLQUFBLEtBQUEsS0FBQSxHQUFBLENBQUEsSUFBQSxLQUFBLEdBQUEsR0FBQTs7O3NCQUlBLFFBQUEsR0FBQSxJQUFBLENBQUEsU0FBQSxDQUFBLEdBQUEsR0FBQSxDQUFBO3NCQUNBLEtBQUEsR0FBQSxNQUFBLENBQUEsUUFBQTtxQkFDQSxNQUFBLENBQUEsU0FBQSxDQUFBLEtBQUEsS0FBQSxLQUFBLEdBQUEsQ0FBQSxJQUFBLEtBQUEsR0FBQSxHQUFBOzs7O0FBSUEseUJBQUE7QUFBQSx5QkFBQTs7OztjQUlBLEtBQUEsRUFBQSx1QkFBQSxFQUFBLElBQUE7O3NCQUdBLFdBQUEsQ0FDQSxJQUFBLEVBQ0EsSUFBQTtVQUVBLEVBQUEsT0FBQSxlQUFBLENBQUEsSUFBQTtVQUNBLFNBQUEsU0FBQSxFQUFBLENBQUEsUUFBQSxHQUFBLENBQUEsRUFBQSw4QkFBQTtRQUNBLFNBQUEsS0FBQSxJQUFBLFNBQUEsSUFBQTtVQUNBLE9BQUEsU0FBQSxFQUFBLENBQUEsY0FBQTtRQUNBLE9BQUEsS0FBQSxJQUFBLFlBQUEsSUFBQSxDQUFBLE1BQUEsQ0FBQSxhQUFBO1VBRUEsR0FBQSxPQUFBLGFBQUE7QUFDQSxPQUFBLENBQUEsSUFBQSxHQUFBLElBQUE7QUFDQSxPQUFBLENBQUEsQ0FBQSxHQUFBLElBQUE7S0FDQSxHQUFBLENBQUEsTUFBQSxFQUFBLEdBQUEsQ0FBQSxHQUFBLEVBQUEsR0FBQSxDQUFBLEtBQUEsSUFBQSxTQUFBLENBQUEsS0FBQSxFQUFBLENBQUEsR0FBQSxDQUFBO0tBQ0EsR0FBQSxDQUFBLFVBQUEsRUFBQSxHQUFBLENBQUEsVUFBQSxJQUFBLGdCQUFBLENBQUEsR0FBQSxDQUFBLEtBQUE7QUFDQSxPQUFBLENBQUEsT0FBQSxHQUFBLE9BQUE7QUFDQSxhQUFBLENBQUEsR0FBQTtXQUNBLEdBQUE7O1NBR0EsU0FBQSxDQUFBLEdBQUE7VUFDQSxhQUFBLEdBQUEsR0FBQSxDQUFBLE9BQUEsQ0FBQSxHQUFBLEVBQUEsY0FBQTtRQUNBLGFBQUE7Y0FDQSxPQUFBLEdBQUEsYUFBQSxDQUFBLEtBQUEsRUFBQSxDQUFBO1lBQ0EsT0FBQSxDQUFBLE1BQUEsR0FBQSxDQUFBO2tCQUNBLFFBQUE7dUJBQUEsR0FBQSxDQUFBLE9BQUEsQ0FBQSxHQUFBLEVBQUEsQ0FBQSxHQUFBLENBQUEsQ0FBQSxJQUFBOzs7Z0JBQ0EsUUFBQSxDQUFBLE1BQUEsR0FBQSxDQUFBO3NCQUNBLEtBQUEsRUFBQSw4Q0FBQTs7QUFFQSxtQkFBQSxDQUFBLE9BQUEsQ0FBQSxHQUFBLEVBQUEsY0FBQSxHQUFBLFFBQUEsQ0FBQSxDQUFBOzs7Y0FHQSxDQUFBLEdBQUEsR0FBQSxDQUFBLE9BQUEsQ0FBQSxHQUFBLEVBQUEsY0FBQTtZQUNBLEdBQUEsQ0FBQSxNQUFBLE1BQUEsSUFBQSxLQUFBLENBQUEsSUFBQSxDQUFBLE1BQUEsQ0FBQTtrQkFDQSxLQUFBLEVBQUEsNENBQUE7O1lBRUEsQ0FBQSxJQUFBLEdBQUEsQ0FBQSxPQUFBLENBQUEsR0FBQSxFQUFBLGlCQUFBO0FBQ0EsY0FBQSxvRUFBQTtBQUNBLGNBQUEsZ0RBQUE7QUFDQSxjQUFBLHVEQUFBO3NCQUNBLEtBQUEsRUFDQSxrRUFBQSJ9