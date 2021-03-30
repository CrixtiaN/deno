import { copy } from "../bytes/mod.ts";
import { assert } from "../_util/assert.ts";
const DEFAULT_BUF_SIZE = 4096;
const MIN_BUF_SIZE = 16;
const MAX_CONSECUTIVE_EMPTY_READS = 100;
const CR = "\r".charCodeAt(0);
const LF = "\n".charCodeAt(0);
export class BufferFullError extends Error {
    name = "BufferFullError";
    constructor(partial){
        super("Buffer full");
        this.partial = partial;
    }
}
export class PartialReadError extends Deno.errors.UnexpectedEof {
    name = "PartialReadError";
    constructor(){
        super("Encountered UnexpectedEof, data only partially read");
    }
}
/** BufReader implements buffering for a Reader object. */ export class BufReader {
    r = 0;
    w = 0;
    eof = false;
    // private lastByte: number;
    // private lastCharSize: number;
    /** return new BufReader unless r is BufReader */ static create(r, size = DEFAULT_BUF_SIZE) {
        return r instanceof BufReader ? r : new BufReader(r, size);
    }
    constructor(rd, size = DEFAULT_BUF_SIZE){
        if (size < MIN_BUF_SIZE) {
            size = MIN_BUF_SIZE;
        }
        this._reset(new Uint8Array(size), rd);
    }
    /** Returns the size of the underlying buffer in bytes. */ size() {
        return this.buf.byteLength;
    }
    buffered() {
        return this.w - this.r;
    }
    // Reads a new chunk into the buffer.
    async _fill() {
        // Slide existing data to beginning.
        if (this.r > 0) {
            this.buf.copyWithin(0, this.r, this.w);
            this.w -= this.r;
            this.r = 0;
        }
        if (this.w >= this.buf.byteLength) {
            throw Error("bufio: tried to fill full buffer");
        }
        // Read new data: try a limited number of times.
        for(let i = MAX_CONSECUTIVE_EMPTY_READS; i > 0; i--){
            const rr = await this.rd.read(this.buf.subarray(this.w));
            if (rr === null) {
                this.eof = true;
                return;
            }
            assert(rr >= 0, "negative read");
            this.w += rr;
            if (rr > 0) {
                return;
            }
        }
        throw new Error(`No progress after ${MAX_CONSECUTIVE_EMPTY_READS} read() calls`);
    }
    /** Discards any buffered data, resets all state, and switches
   * the buffered reader to read from r.
   */ reset(r) {
        this._reset(this.buf, r);
    }
    _reset(buf, rd) {
        this.buf = buf;
        this.rd = rd;
        this.eof = false;
    }
    /** reads data into p.
   * It returns the number of bytes read into p.
   * The bytes are taken from at most one Read on the underlying Reader,
   * hence n may be less than len(p).
   * To read exactly len(p) bytes, use io.ReadFull(b, p).
   */ async read(p) {
        let rr = p.byteLength;
        if (p.byteLength === 0) return rr;
        if (this.r === this.w) {
            if (p.byteLength >= this.buf.byteLength) {
                // Large read, empty buffer.
                // Read directly into p to avoid copy.
                const rr = await this.rd.read(p);
                const nread = rr ?? 0;
                assert(nread >= 0, "negative read");
                // if (rr.nread > 0) {
                //   this.lastByte = p[rr.nread - 1];
                //   this.lastCharSize = -1;
                // }
                return rr;
            }
            // One read.
            // Do not use this.fill, which will loop.
            this.r = 0;
            this.w = 0;
            rr = await this.rd.read(this.buf);
            if (rr === 0 || rr === null) return rr;
            assert(rr >= 0, "negative read");
            this.w += rr;
        }
        // copy as much as we can
        const copied = copy(this.buf.subarray(this.r, this.w), p, 0);
        this.r += copied;
        // this.lastByte = this.buf[this.r - 1];
        // this.lastCharSize = -1;
        return copied;
    }
    /** reads exactly `p.length` bytes into `p`.
   *
   * If successful, `p` is returned.
   *
   * If the end of the underlying stream has been reached, and there are no more
   * bytes available in the buffer, `readFull()` returns `null` instead.
   *
   * An error is thrown if some bytes could be read, but not enough to fill `p`
   * entirely before the underlying stream reported an error or EOF. Any error
   * thrown will have a `partial` property that indicates the slice of the
   * buffer that has been successfully filled with data.
   *
   * Ported from https://golang.org/pkg/io/#ReadFull
   */ async readFull(p) {
        let bytesRead = 0;
        while(bytesRead < p.length){
            try {
                const rr = await this.read(p.subarray(bytesRead));
                if (rr === null) {
                    if (bytesRead === 0) {
                        return null;
                    } else {
                        throw new PartialReadError();
                    }
                }
                bytesRead += rr;
            } catch (err) {
                err.partial = p.subarray(0, bytesRead);
                throw err;
            }
        }
        return p;
    }
    /** Returns the next byte [0, 255] or `null`. */ async readByte() {
        while(this.r === this.w){
            if (this.eof) return null;
            await this._fill(); // buffer is empty.
        }
        const c = this.buf[this.r];
        this.r++;
        // this.lastByte = c;
        return c;
    }
    /** readString() reads until the first occurrence of delim in the input,
   * returning a string containing the data up to and including the delimiter.
   * If ReadString encounters an error before finding a delimiter,
   * it returns the data read before the error and the error itself
   * (often `null`).
   * ReadString returns err != nil if and only if the returned data does not end
   * in delim.
   * For simple uses, a Scanner may be more convenient.
   */ async readString(delim) {
        if (delim.length !== 1) {
            throw new Error("Delimiter should be a single character");
        }
        const buffer = await this.readSlice(delim.charCodeAt(0));
        if (buffer === null) return null;
        return new TextDecoder().decode(buffer);
    }
    /** `readLine()` is a low-level line-reading primitive. Most callers should
   * use `readString('\n')` instead or use a Scanner.
   *
   * `readLine()` tries to return a single line, not including the end-of-line
   * bytes. If the line was too long for the buffer then `more` is set and the
   * beginning of the line is returned. The rest of the line will be returned
   * from future calls. `more` will be false when returning the last fragment
   * of the line. The returned buffer is only valid until the next call to
   * `readLine()`.
   *
   * The text returned from ReadLine does not include the line end ("\r\n" or
   * "\n").
   *
   * When the end of the underlying stream is reached, the final bytes in the
   * stream are returned. No indication or error is given if the input ends
   * without a final line end. When there are no more trailing bytes to read,
   * `readLine()` returns `null`.
   *
   * Calling `unreadByte()` after `readLine()` will always unread the last byte
   * read (possibly a character belonging to the line end) even if that byte is
   * not part of the line returned by `readLine()`.
   */ async readLine() {
        let line;
        try {
            line = await this.readSlice(LF);
        } catch (err) {
            let { partial  } = err;
            assert(partial instanceof Uint8Array, "bufio: caught error from `readSlice()` without `partial` property");
            // Don't throw if `readSlice()` failed with `BufferFullError`, instead we
            // just return whatever is available and set the `more` flag.
            if (!(err instanceof BufferFullError)) {
                throw err;
            }
            // Handle the case where "\r\n" straddles the buffer.
            if (!this.eof && partial.byteLength > 0 && partial[partial.byteLength - 1] === CR) {
                // Put the '\r' back on buf and drop it from line.
                // Let the next call to ReadLine check for "\r\n".
                assert(this.r > 0, "bufio: tried to rewind past start of buffer");
                this.r--;
                partial = partial.subarray(0, partial.byteLength - 1);
            }
            return {
                line: partial,
                more: !this.eof
            };
        }
        if (line === null) {
            return null;
        }
        if (line.byteLength === 0) {
            return {
                line,
                more: false
            };
        }
        if (line[line.byteLength - 1] == LF) {
            let drop = 1;
            if (line.byteLength > 1 && line[line.byteLength - 2] === CR) {
                drop = 2;
            }
            line = line.subarray(0, line.byteLength - drop);
        }
        return {
            line,
            more: false
        };
    }
    /** `readSlice()` reads until the first occurrence of `delim` in the input,
   * returning a slice pointing at the bytes in the buffer. The bytes stop
   * being valid at the next read.
   *
   * If `readSlice()` encounters an error before finding a delimiter, or the
   * buffer fills without finding a delimiter, it throws an error with a
   * `partial` property that contains the entire buffer.
   *
   * If `readSlice()` encounters the end of the underlying stream and there are
   * any bytes left in the buffer, the rest of the buffer is returned. In other
   * words, EOF is always treated as a delimiter. Once the buffer is empty,
   * it returns `null`.
   *
   * Because the data returned from `readSlice()` will be overwritten by the
   * next I/O operation, most clients should use `readString()` instead.
   */ async readSlice(delim) {
        let s = 0; // search start index
        let slice;
        while(true){
            // Search buffer.
            let i = this.buf.subarray(this.r + s, this.w).indexOf(delim);
            if (i >= 0) {
                i += s;
                slice = this.buf.subarray(this.r, this.r + i + 1);
                this.r += i + 1;
                break;
            }
            // EOF?
            if (this.eof) {
                if (this.r === this.w) {
                    return null;
                }
                slice = this.buf.subarray(this.r, this.w);
                this.r = this.w;
                break;
            }
            // Buffer full?
            if (this.buffered() >= this.buf.byteLength) {
                this.r = this.w;
                // #4521 The internal buffer should not be reused across reads because it causes corruption of data.
                const oldbuf = this.buf;
                const newbuf = this.buf.slice(0);
                this.buf = newbuf;
                throw new BufferFullError(oldbuf);
            }
            s = this.w - this.r; // do not rescan area we scanned before
            // Buffer is not full.
            try {
                await this._fill();
            } catch (err) {
                err.partial = slice;
                throw err;
            }
        }
        // Handle last byte, if any.
        // const i = slice.byteLength - 1;
        // if (i >= 0) {
        //   this.lastByte = slice[i];
        //   this.lastCharSize = -1
        // }
        return slice;
    }
    /** `peek()` returns the next `n` bytes without advancing the reader. The
   * bytes stop being valid at the next read call.
   *
   * When the end of the underlying stream is reached, but there are unread
   * bytes left in the buffer, those bytes are returned. If there are no bytes
   * left in the buffer, it returns `null`.
   *
   * If an error is encountered before `n` bytes are available, `peek()` throws
   * an error with the `partial` property set to a slice of the buffer that
   * contains the bytes that were available before the error occurred.
   */ async peek(n) {
        if (n < 0) {
            throw Error("negative count");
        }
        let avail = this.w - this.r;
        while(avail < n && avail < this.buf.byteLength && !this.eof){
            try {
                await this._fill();
            } catch (err) {
                err.partial = this.buf.subarray(this.r, this.w);
                throw err;
            }
            avail = this.w - this.r;
        }
        if (avail === 0 && this.eof) {
            return null;
        } else if (avail < n && this.eof) {
            return this.buf.subarray(this.r, this.r + avail);
        } else if (avail < n) {
            throw new BufferFullError(this.buf.subarray(this.r, this.w));
        }
        return this.buf.subarray(this.r, this.r + n);
    }
}
class AbstractBufBase {
    usedBufferBytes = 0;
    err = null;
    /** Size returns the size of the underlying buffer in bytes. */ size() {
        return this.buf.byteLength;
    }
    /** Returns how many bytes are unused in the buffer. */ available() {
        return this.buf.byteLength - this.usedBufferBytes;
    }
    /** buffered returns the number of bytes that have been written into the
   * current buffer.
   */ buffered() {
        return this.usedBufferBytes;
    }
}
/** BufWriter implements buffering for an deno.Writer object.
 * If an error occurs writing to a Writer, no more data will be
 * accepted and all subsequent writes, and flush(), will return the error.
 * After all data has been written, the client should call the
 * flush() method to guarantee all data has been forwarded to
 * the underlying deno.Writer.
 */ export class BufWriter extends AbstractBufBase {
    /** return new BufWriter unless writer is BufWriter */ static create(writer, size = DEFAULT_BUF_SIZE) {
        return writer instanceof BufWriter ? writer : new BufWriter(writer, size);
    }
    constructor(writer, size = DEFAULT_BUF_SIZE){
        super();
        this.writer = writer;
        if (size <= 0) {
            size = DEFAULT_BUF_SIZE;
        }
        this.buf = new Uint8Array(size);
    }
    /** Discards any unflushed buffered data, clears any error, and
   * resets buffer to write its output to w.
   */ reset(w) {
        this.err = null;
        this.usedBufferBytes = 0;
        this.writer = w;
    }
    /** Flush writes any buffered data to the underlying io.Writer. */ async flush() {
        if (this.err !== null) throw this.err;
        if (this.usedBufferBytes === 0) return;
        try {
            await Deno.writeAll(this.writer, this.buf.subarray(0, this.usedBufferBytes));
        } catch (e) {
            this.err = e;
            throw e;
        }
        this.buf = new Uint8Array(this.buf.length);
        this.usedBufferBytes = 0;
    }
    /** Writes the contents of `data` into the buffer.  If the contents won't fully
   * fit into the buffer, those bytes that can are copied into the buffer, the
   * buffer is the flushed to the writer and the remaining bytes are copied into
   * the now empty buffer.
   *
   * @return the number of bytes written to the buffer.
   */ async write(data) {
        if (this.err !== null) throw this.err;
        if (data.length === 0) return 0;
        let totalBytesWritten = 0;
        let numBytesWritten = 0;
        while(data.byteLength > this.available()){
            if (this.buffered() === 0) {
                // Large write, empty buffer.
                // Write directly from data to avoid copy.
                try {
                    numBytesWritten = await this.writer.write(data);
                } catch (e) {
                    this.err = e;
                    throw e;
                }
            } else {
                numBytesWritten = copy(data, this.buf, this.usedBufferBytes);
                this.usedBufferBytes += numBytesWritten;
                await this.flush();
            }
            totalBytesWritten += numBytesWritten;
            data = data.subarray(numBytesWritten);
        }
        numBytesWritten = copy(data, this.buf, this.usedBufferBytes);
        this.usedBufferBytes += numBytesWritten;
        totalBytesWritten += numBytesWritten;
        return totalBytesWritten;
    }
}
/** BufWriterSync implements buffering for a deno.WriterSync object.
 * If an error occurs writing to a WriterSync, no more data will be
 * accepted and all subsequent writes, and flush(), will return the error.
 * After all data has been written, the client should call the
 * flush() method to guarantee all data has been forwarded to
 * the underlying deno.WriterSync.
 */ export class BufWriterSync extends AbstractBufBase {
    /** return new BufWriterSync unless writer is BufWriterSync */ static create(writer, size = DEFAULT_BUF_SIZE) {
        return writer instanceof BufWriterSync ? writer : new BufWriterSync(writer, size);
    }
    constructor(writer, size = DEFAULT_BUF_SIZE){
        super();
        this.writer = writer;
        if (size <= 0) {
            size = DEFAULT_BUF_SIZE;
        }
        this.buf = new Uint8Array(size);
    }
    /** Discards any unflushed buffered data, clears any error, and
   * resets buffer to write its output to w.
   */ reset(w) {
        this.err = null;
        this.usedBufferBytes = 0;
        this.writer = w;
    }
    /** Flush writes any buffered data to the underlying io.WriterSync. */ flush() {
        if (this.err !== null) throw this.err;
        if (this.usedBufferBytes === 0) return;
        try {
            Deno.writeAllSync(this.writer, this.buf.subarray(0, this.usedBufferBytes));
        } catch (e) {
            this.err = e;
            throw e;
        }
        this.buf = new Uint8Array(this.buf.length);
        this.usedBufferBytes = 0;
    }
    /** Writes the contents of `data` into the buffer.  If the contents won't fully
   * fit into the buffer, those bytes that can are copied into the buffer, the
   * buffer is the flushed to the writer and the remaining bytes are copied into
   * the now empty buffer.
   *
   * @return the number of bytes written to the buffer.
   */ writeSync(data) {
        if (this.err !== null) throw this.err;
        if (data.length === 0) return 0;
        let totalBytesWritten = 0;
        let numBytesWritten = 0;
        while(data.byteLength > this.available()){
            if (this.buffered() === 0) {
                // Large write, empty buffer.
                // Write directly from data to avoid copy.
                try {
                    numBytesWritten = this.writer.writeSync(data);
                } catch (e) {
                    this.err = e;
                    throw e;
                }
            } else {
                numBytesWritten = copy(data, this.buf, this.usedBufferBytes);
                this.usedBufferBytes += numBytesWritten;
                this.flush();
            }
            totalBytesWritten += numBytesWritten;
            data = data.subarray(numBytesWritten);
        }
        numBytesWritten = copy(data, this.buf, this.usedBufferBytes);
        this.usedBufferBytes += numBytesWritten;
        totalBytesWritten += numBytesWritten;
        return totalBytesWritten;
    }
}
/** Generate longest proper prefix which is also suffix array. */ function createLPS(pat) {
    const lps = new Uint8Array(pat.length);
    lps[0] = 0;
    let prefixEnd = 0;
    let i = 1;
    while(i < lps.length){
        if (pat[i] == pat[prefixEnd]) {
            prefixEnd++;
            lps[i] = prefixEnd;
            i++;
        } else if (prefixEnd === 0) {
            lps[i] = 0;
            i++;
        } else {
            prefixEnd = pat[prefixEnd - 1];
        }
    }
    return lps;
}
/** Read delimited bytes from a Reader. */ export async function* readDelim(reader, delim) {
    // Avoid unicode problems
    const delimLen = delim.length;
    const delimLPS = createLPS(delim);
    let inputBuffer = new Deno.Buffer();
    const inspectArr = new Uint8Array(Math.max(1024, delimLen + 1));
    // Modified KMP
    let inspectIndex = 0;
    let matchIndex = 0;
    while(true){
        const result = await reader.read(inspectArr);
        if (result === null) {
            // Yield last chunk.
            yield inputBuffer.bytes();
            return;
        }
        if (result < 0) {
            // Discard all remaining and silently fail.
            return;
        }
        const sliceRead = inspectArr.subarray(0, result);
        await Deno.writeAll(inputBuffer, sliceRead);
        let sliceToProcess = inputBuffer.bytes();
        while(inspectIndex < sliceToProcess.length){
            if (sliceToProcess[inspectIndex] === delim[matchIndex]) {
                inspectIndex++;
                matchIndex++;
                if (matchIndex === delimLen) {
                    // Full match
                    const matchEnd = inspectIndex - delimLen;
                    const readyBytes = sliceToProcess.subarray(0, matchEnd);
                    // Copy
                    const pendingBytes = sliceToProcess.slice(inspectIndex);
                    yield readyBytes;
                    // Reset match, different from KMP.
                    sliceToProcess = pendingBytes;
                    inspectIndex = 0;
                    matchIndex = 0;
                }
            } else {
                if (matchIndex === 0) {
                    inspectIndex++;
                } else {
                    matchIndex = delimLPS[matchIndex - 1];
                }
            }
        }
        // Keep inspectIndex and matchIndex.
        inputBuffer = new Deno.Buffer(sliceToProcess);
    }
}
/** Read delimited strings from a Reader. */ export async function* readStringDelim(reader, delim) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    for await (const chunk of readDelim(reader, encoder.encode(delim))){
        yield decoder.decode(chunk);
    }
}
/** Read strings line-by-line from a Reader. */ export async function* readLines(reader) {
    for await (let chunk of readStringDelim(reader, "\n")){
        // Finding a CR at the end of the line is evidence of a
        // "\r\n" at the end of the line. The "\r" part should be
        // removed too.
        if (chunk.endsWith("\r")) {
            chunk = chunk.slice(0, -1);
        }
        yield chunk;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIjxodHRwczovL2Rlbm8ubGFuZC9zdGRAMC44NC4wL2lvL2J1ZmlvLnRzPiJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDIxIHRoZSBEZW5vIGF1dGhvcnMuIEFsbCByaWdodHMgcmVzZXJ2ZWQuIE1JVCBsaWNlbnNlLlxuLy8gQmFzZWQgb24gaHR0cHM6Ly9naXRodWIuY29tL2dvbGFuZy9nby9ibG9iLzg5MTY4Mi9zcmMvYnVmaW8vYnVmaW8uZ29cbi8vIENvcHlyaWdodCAyMDA5IFRoZSBHbyBBdXRob3JzLiBBbGwgcmlnaHRzIHJlc2VydmVkLlxuLy8gVXNlIG9mIHRoaXMgc291cmNlIGNvZGUgaXMgZ292ZXJuZWQgYnkgYSBCU0Qtc3R5bGVcbi8vIGxpY2Vuc2UgdGhhdCBjYW4gYmUgZm91bmQgaW4gdGhlIExJQ0VOU0UgZmlsZS5cblxudHlwZSBSZWFkZXIgPSBEZW5vLlJlYWRlcjtcbnR5cGUgV3JpdGVyID0gRGVuby5Xcml0ZXI7XG50eXBlIFdyaXRlclN5bmMgPSBEZW5vLldyaXRlclN5bmM7XG5pbXBvcnQgeyBjb3B5IH0gZnJvbSBcIi4uL2J5dGVzL21vZC50c1wiO1xuaW1wb3J0IHsgYXNzZXJ0IH0gZnJvbSBcIi4uL191dGlsL2Fzc2VydC50c1wiO1xuXG5jb25zdCBERUZBVUxUX0JVRl9TSVpFID0gNDA5NjtcbmNvbnN0IE1JTl9CVUZfU0laRSA9IDE2O1xuY29uc3QgTUFYX0NPTlNFQ1VUSVZFX0VNUFRZX1JFQURTID0gMTAwO1xuY29uc3QgQ1IgPSBcIlxcclwiLmNoYXJDb2RlQXQoMCk7XG5jb25zdCBMRiA9IFwiXFxuXCIuY2hhckNvZGVBdCgwKTtcblxuZXhwb3J0IGNsYXNzIEJ1ZmZlckZ1bGxFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgbmFtZSA9IFwiQnVmZmVyRnVsbEVycm9yXCI7XG4gIGNvbnN0cnVjdG9yKHB1YmxpYyBwYXJ0aWFsOiBVaW50OEFycmF5KSB7XG4gICAgc3VwZXIoXCJCdWZmZXIgZnVsbFwiKTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgUGFydGlhbFJlYWRFcnJvciBleHRlbmRzIERlbm8uZXJyb3JzLlVuZXhwZWN0ZWRFb2Yge1xuICBuYW1lID0gXCJQYXJ0aWFsUmVhZEVycm9yXCI7XG4gIHBhcnRpYWw/OiBVaW50OEFycmF5O1xuICBjb25zdHJ1Y3RvcigpIHtcbiAgICBzdXBlcihcIkVuY291bnRlcmVkIFVuZXhwZWN0ZWRFb2YsIGRhdGEgb25seSBwYXJ0aWFsbHkgcmVhZFwiKTtcbiAgfVxufVxuXG4vKiogUmVzdWx0IHR5cGUgcmV0dXJuZWQgYnkgb2YgQnVmUmVhZGVyLnJlYWRMaW5lKCkuICovXG5leHBvcnQgaW50ZXJmYWNlIFJlYWRMaW5lUmVzdWx0IHtcbiAgbGluZTogVWludDhBcnJheTtcbiAgbW9yZTogYm9vbGVhbjtcbn1cblxuLyoqIEJ1ZlJlYWRlciBpbXBsZW1lbnRzIGJ1ZmZlcmluZyBmb3IgYSBSZWFkZXIgb2JqZWN0LiAqL1xuZXhwb3J0IGNsYXNzIEJ1ZlJlYWRlciBpbXBsZW1lbnRzIFJlYWRlciB7XG4gIHByaXZhdGUgYnVmITogVWludDhBcnJheTtcbiAgcHJpdmF0ZSByZCE6IFJlYWRlcjsgLy8gUmVhZGVyIHByb3ZpZGVkIGJ5IGNhbGxlci5cbiAgcHJpdmF0ZSByID0gMDsgLy8gYnVmIHJlYWQgcG9zaXRpb24uXG4gIHByaXZhdGUgdyA9IDA7IC8vIGJ1ZiB3cml0ZSBwb3NpdGlvbi5cbiAgcHJpdmF0ZSBlb2YgPSBmYWxzZTtcbiAgLy8gcHJpdmF0ZSBsYXN0Qnl0ZTogbnVtYmVyO1xuICAvLyBwcml2YXRlIGxhc3RDaGFyU2l6ZTogbnVtYmVyO1xuXG4gIC8qKiByZXR1cm4gbmV3IEJ1ZlJlYWRlciB1bmxlc3MgciBpcyBCdWZSZWFkZXIgKi9cbiAgc3RhdGljIGNyZWF0ZShyOiBSZWFkZXIsIHNpemU6IG51bWJlciA9IERFRkFVTFRfQlVGX1NJWkUpOiBCdWZSZWFkZXIge1xuICAgIHJldHVybiByIGluc3RhbmNlb2YgQnVmUmVhZGVyID8gciA6IG5ldyBCdWZSZWFkZXIociwgc2l6ZSk7XG4gIH1cblxuICBjb25zdHJ1Y3RvcihyZDogUmVhZGVyLCBzaXplOiBudW1iZXIgPSBERUZBVUxUX0JVRl9TSVpFKSB7XG4gICAgaWYgKHNpemUgPCBNSU5fQlVGX1NJWkUpIHtcbiAgICAgIHNpemUgPSBNSU5fQlVGX1NJWkU7XG4gICAgfVxuICAgIHRoaXMuX3Jlc2V0KG5ldyBVaW50OEFycmF5KHNpemUpLCByZCk7XG4gIH1cblxuICAvKiogUmV0dXJucyB0aGUgc2l6ZSBvZiB0aGUgdW5kZXJseWluZyBidWZmZXIgaW4gYnl0ZXMuICovXG4gIHNpemUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5idWYuYnl0ZUxlbmd0aDtcbiAgfVxuXG4gIGJ1ZmZlcmVkKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMudyAtIHRoaXMucjtcbiAgfVxuXG4gIC8vIFJlYWRzIGEgbmV3IGNodW5rIGludG8gdGhlIGJ1ZmZlci5cbiAgcHJpdmF0ZSBhc3luYyBfZmlsbCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvLyBTbGlkZSBleGlzdGluZyBkYXRhIHRvIGJlZ2lubmluZy5cbiAgICBpZiAodGhpcy5yID4gMCkge1xuICAgICAgdGhpcy5idWYuY29weVdpdGhpbigwLCB0aGlzLnIsIHRoaXMudyk7XG4gICAgICB0aGlzLncgLT0gdGhpcy5yO1xuICAgICAgdGhpcy5yID0gMDtcbiAgICB9XG5cbiAgICBpZiAodGhpcy53ID49IHRoaXMuYnVmLmJ5dGVMZW5ndGgpIHtcbiAgICAgIHRocm93IEVycm9yKFwiYnVmaW86IHRyaWVkIHRvIGZpbGwgZnVsbCBidWZmZXJcIik7XG4gICAgfVxuXG4gICAgLy8gUmVhZCBuZXcgZGF0YTogdHJ5IGEgbGltaXRlZCBudW1iZXIgb2YgdGltZXMuXG4gICAgZm9yIChsZXQgaSA9IE1BWF9DT05TRUNVVElWRV9FTVBUWV9SRUFEUzsgaSA+IDA7IGktLSkge1xuICAgICAgY29uc3QgcnIgPSBhd2FpdCB0aGlzLnJkLnJlYWQodGhpcy5idWYuc3ViYXJyYXkodGhpcy53KSk7XG4gICAgICBpZiAocnIgPT09IG51bGwpIHtcbiAgICAgICAgdGhpcy5lb2YgPSB0cnVlO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBhc3NlcnQocnIgPj0gMCwgXCJuZWdhdGl2ZSByZWFkXCIpO1xuICAgICAgdGhpcy53ICs9IHJyO1xuICAgICAgaWYgKHJyID4gMCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYE5vIHByb2dyZXNzIGFmdGVyICR7TUFYX0NPTlNFQ1VUSVZFX0VNUFRZX1JFQURTfSByZWFkKCkgY2FsbHNgLFxuICAgICk7XG4gIH1cblxuICAvKiogRGlzY2FyZHMgYW55IGJ1ZmZlcmVkIGRhdGEsIHJlc2V0cyBhbGwgc3RhdGUsIGFuZCBzd2l0Y2hlc1xuICAgKiB0aGUgYnVmZmVyZWQgcmVhZGVyIHRvIHJlYWQgZnJvbSByLlxuICAgKi9cbiAgcmVzZXQocjogUmVhZGVyKTogdm9pZCB7XG4gICAgdGhpcy5fcmVzZXQodGhpcy5idWYsIHIpO1xuICB9XG5cbiAgcHJpdmF0ZSBfcmVzZXQoYnVmOiBVaW50OEFycmF5LCByZDogUmVhZGVyKTogdm9pZCB7XG4gICAgdGhpcy5idWYgPSBidWY7XG4gICAgdGhpcy5yZCA9IHJkO1xuICAgIHRoaXMuZW9mID0gZmFsc2U7XG4gICAgLy8gdGhpcy5sYXN0Qnl0ZSA9IC0xO1xuICAgIC8vIHRoaXMubGFzdENoYXJTaXplID0gLTE7XG4gIH1cblxuICAvKiogcmVhZHMgZGF0YSBpbnRvIHAuXG4gICAqIEl0IHJldHVybnMgdGhlIG51bWJlciBvZiBieXRlcyByZWFkIGludG8gcC5cbiAgICogVGhlIGJ5dGVzIGFyZSB0YWtlbiBmcm9tIGF0IG1vc3Qgb25lIFJlYWQgb24gdGhlIHVuZGVybHlpbmcgUmVhZGVyLFxuICAgKiBoZW5jZSBuIG1heSBiZSBsZXNzIHRoYW4gbGVuKHApLlxuICAgKiBUbyByZWFkIGV4YWN0bHkgbGVuKHApIGJ5dGVzLCB1c2UgaW8uUmVhZEZ1bGwoYiwgcCkuXG4gICAqL1xuICBhc3luYyByZWFkKHA6IFVpbnQ4QXJyYXkpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgICBsZXQgcnI6IG51bWJlciB8IG51bGwgPSBwLmJ5dGVMZW5ndGg7XG4gICAgaWYgKHAuYnl0ZUxlbmd0aCA9PT0gMCkgcmV0dXJuIHJyO1xuXG4gICAgaWYgKHRoaXMuciA9PT0gdGhpcy53KSB7XG4gICAgICBpZiAocC5ieXRlTGVuZ3RoID49IHRoaXMuYnVmLmJ5dGVMZW5ndGgpIHtcbiAgICAgICAgLy8gTGFyZ2UgcmVhZCwgZW1wdHkgYnVmZmVyLlxuICAgICAgICAvLyBSZWFkIGRpcmVjdGx5IGludG8gcCB0byBhdm9pZCBjb3B5LlxuICAgICAgICBjb25zdCByciA9IGF3YWl0IHRoaXMucmQucmVhZChwKTtcbiAgICAgICAgY29uc3QgbnJlYWQgPSByciA/PyAwO1xuICAgICAgICBhc3NlcnQobnJlYWQgPj0gMCwgXCJuZWdhdGl2ZSByZWFkXCIpO1xuICAgICAgICAvLyBpZiAocnIubnJlYWQgPiAwKSB7XG4gICAgICAgIC8vICAgdGhpcy5sYXN0Qnl0ZSA9IHBbcnIubnJlYWQgLSAxXTtcbiAgICAgICAgLy8gICB0aGlzLmxhc3RDaGFyU2l6ZSA9IC0xO1xuICAgICAgICAvLyB9XG4gICAgICAgIHJldHVybiBycjtcbiAgICAgIH1cblxuICAgICAgLy8gT25lIHJlYWQuXG4gICAgICAvLyBEbyBub3QgdXNlIHRoaXMuZmlsbCwgd2hpY2ggd2lsbCBsb29wLlxuICAgICAgdGhpcy5yID0gMDtcbiAgICAgIHRoaXMudyA9IDA7XG4gICAgICByciA9IGF3YWl0IHRoaXMucmQucmVhZCh0aGlzLmJ1Zik7XG4gICAgICBpZiAocnIgPT09IDAgfHwgcnIgPT09IG51bGwpIHJldHVybiBycjtcbiAgICAgIGFzc2VydChyciA+PSAwLCBcIm5lZ2F0aXZlIHJlYWRcIik7XG4gICAgICB0aGlzLncgKz0gcnI7XG4gICAgfVxuXG4gICAgLy8gY29weSBhcyBtdWNoIGFzIHdlIGNhblxuICAgIGNvbnN0IGNvcGllZCA9IGNvcHkodGhpcy5idWYuc3ViYXJyYXkodGhpcy5yLCB0aGlzLncpLCBwLCAwKTtcbiAgICB0aGlzLnIgKz0gY29waWVkO1xuICAgIC8vIHRoaXMubGFzdEJ5dGUgPSB0aGlzLmJ1Zlt0aGlzLnIgLSAxXTtcbiAgICAvLyB0aGlzLmxhc3RDaGFyU2l6ZSA9IC0xO1xuICAgIHJldHVybiBjb3BpZWQ7XG4gIH1cblxuICAvKiogcmVhZHMgZXhhY3RseSBgcC5sZW5ndGhgIGJ5dGVzIGludG8gYHBgLlxuICAgKlxuICAgKiBJZiBzdWNjZXNzZnVsLCBgcGAgaXMgcmV0dXJuZWQuXG4gICAqXG4gICAqIElmIHRoZSBlbmQgb2YgdGhlIHVuZGVybHlpbmcgc3RyZWFtIGhhcyBiZWVuIHJlYWNoZWQsIGFuZCB0aGVyZSBhcmUgbm8gbW9yZVxuICAgKiBieXRlcyBhdmFpbGFibGUgaW4gdGhlIGJ1ZmZlciwgYHJlYWRGdWxsKClgIHJldHVybnMgYG51bGxgIGluc3RlYWQuXG4gICAqXG4gICAqIEFuIGVycm9yIGlzIHRocm93biBpZiBzb21lIGJ5dGVzIGNvdWxkIGJlIHJlYWQsIGJ1dCBub3QgZW5vdWdoIHRvIGZpbGwgYHBgXG4gICAqIGVudGlyZWx5IGJlZm9yZSB0aGUgdW5kZXJseWluZyBzdHJlYW0gcmVwb3J0ZWQgYW4gZXJyb3Igb3IgRU9GLiBBbnkgZXJyb3JcbiAgICogdGhyb3duIHdpbGwgaGF2ZSBhIGBwYXJ0aWFsYCBwcm9wZXJ0eSB0aGF0IGluZGljYXRlcyB0aGUgc2xpY2Ugb2YgdGhlXG4gICAqIGJ1ZmZlciB0aGF0IGhhcyBiZWVuIHN1Y2Nlc3NmdWxseSBmaWxsZWQgd2l0aCBkYXRhLlxuICAgKlxuICAgKiBQb3J0ZWQgZnJvbSBodHRwczovL2dvbGFuZy5vcmcvcGtnL2lvLyNSZWFkRnVsbFxuICAgKi9cbiAgYXN5bmMgcmVhZEZ1bGwocDogVWludDhBcnJheSk6IFByb21pc2U8VWludDhBcnJheSB8IG51bGw+IHtcbiAgICBsZXQgYnl0ZXNSZWFkID0gMDtcbiAgICB3aGlsZSAoYnl0ZXNSZWFkIDwgcC5sZW5ndGgpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJyID0gYXdhaXQgdGhpcy5yZWFkKHAuc3ViYXJyYXkoYnl0ZXNSZWFkKSk7XG4gICAgICAgIGlmIChyciA9PT0gbnVsbCkge1xuICAgICAgICAgIGlmIChieXRlc1JlYWQgPT09IDApIHtcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFydGlhbFJlYWRFcnJvcigpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBieXRlc1JlYWQgKz0gcnI7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgZXJyLnBhcnRpYWwgPSBwLnN1YmFycmF5KDAsIGJ5dGVzUmVhZCk7XG4gICAgICAgIHRocm93IGVycjtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHA7XG4gIH1cblxuICAvKiogUmV0dXJucyB0aGUgbmV4dCBieXRlIFswLCAyNTVdIG9yIGBudWxsYC4gKi9cbiAgYXN5bmMgcmVhZEJ5dGUoKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gICAgd2hpbGUgKHRoaXMuciA9PT0gdGhpcy53KSB7XG4gICAgICBpZiAodGhpcy5lb2YpIHJldHVybiBudWxsO1xuICAgICAgYXdhaXQgdGhpcy5fZmlsbCgpOyAvLyBidWZmZXIgaXMgZW1wdHkuXG4gICAgfVxuICAgIGNvbnN0IGMgPSB0aGlzLmJ1Zlt0aGlzLnJdO1xuICAgIHRoaXMucisrO1xuICAgIC8vIHRoaXMubGFzdEJ5dGUgPSBjO1xuICAgIHJldHVybiBjO1xuICB9XG5cbiAgLyoqIHJlYWRTdHJpbmcoKSByZWFkcyB1bnRpbCB0aGUgZmlyc3Qgb2NjdXJyZW5jZSBvZiBkZWxpbSBpbiB0aGUgaW5wdXQsXG4gICAqIHJldHVybmluZyBhIHN0cmluZyBjb250YWluaW5nIHRoZSBkYXRhIHVwIHRvIGFuZCBpbmNsdWRpbmcgdGhlIGRlbGltaXRlci5cbiAgICogSWYgUmVhZFN0cmluZyBlbmNvdW50ZXJzIGFuIGVycm9yIGJlZm9yZSBmaW5kaW5nIGEgZGVsaW1pdGVyLFxuICAgKiBpdCByZXR1cm5zIHRoZSBkYXRhIHJlYWQgYmVmb3JlIHRoZSBlcnJvciBhbmQgdGhlIGVycm9yIGl0c2VsZlxuICAgKiAob2Z0ZW4gYG51bGxgKS5cbiAgICogUmVhZFN0cmluZyByZXR1cm5zIGVyciAhPSBuaWwgaWYgYW5kIG9ubHkgaWYgdGhlIHJldHVybmVkIGRhdGEgZG9lcyBub3QgZW5kXG4gICAqIGluIGRlbGltLlxuICAgKiBGb3Igc2ltcGxlIHVzZXMsIGEgU2Nhbm5lciBtYXkgYmUgbW9yZSBjb252ZW5pZW50LlxuICAgKi9cbiAgYXN5bmMgcmVhZFN0cmluZyhkZWxpbTogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gICAgaWYgKGRlbGltLmxlbmd0aCAhPT0gMSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiRGVsaW1pdGVyIHNob3VsZCBiZSBhIHNpbmdsZSBjaGFyYWN0ZXJcIik7XG4gICAgfVxuICAgIGNvbnN0IGJ1ZmZlciA9IGF3YWl0IHRoaXMucmVhZFNsaWNlKGRlbGltLmNoYXJDb2RlQXQoMCkpO1xuICAgIGlmIChidWZmZXIgPT09IG51bGwpIHJldHVybiBudWxsO1xuICAgIHJldHVybiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUoYnVmZmVyKTtcbiAgfVxuXG4gIC8qKiBgcmVhZExpbmUoKWAgaXMgYSBsb3ctbGV2ZWwgbGluZS1yZWFkaW5nIHByaW1pdGl2ZS4gTW9zdCBjYWxsZXJzIHNob3VsZFxuICAgKiB1c2UgYHJlYWRTdHJpbmcoJ1xcbicpYCBpbnN0ZWFkIG9yIHVzZSBhIFNjYW5uZXIuXG4gICAqXG4gICAqIGByZWFkTGluZSgpYCB0cmllcyB0byByZXR1cm4gYSBzaW5nbGUgbGluZSwgbm90IGluY2x1ZGluZyB0aGUgZW5kLW9mLWxpbmVcbiAgICogYnl0ZXMuIElmIHRoZSBsaW5lIHdhcyB0b28gbG9uZyBmb3IgdGhlIGJ1ZmZlciB0aGVuIGBtb3JlYCBpcyBzZXQgYW5kIHRoZVxuICAgKiBiZWdpbm5pbmcgb2YgdGhlIGxpbmUgaXMgcmV0dXJuZWQuIFRoZSByZXN0IG9mIHRoZSBsaW5lIHdpbGwgYmUgcmV0dXJuZWRcbiAgICogZnJvbSBmdXR1cmUgY2FsbHMuIGBtb3JlYCB3aWxsIGJlIGZhbHNlIHdoZW4gcmV0dXJuaW5nIHRoZSBsYXN0IGZyYWdtZW50XG4gICAqIG9mIHRoZSBsaW5lLiBUaGUgcmV0dXJuZWQgYnVmZmVyIGlzIG9ubHkgdmFsaWQgdW50aWwgdGhlIG5leHQgY2FsbCB0b1xuICAgKiBgcmVhZExpbmUoKWAuXG4gICAqXG4gICAqIFRoZSB0ZXh0IHJldHVybmVkIGZyb20gUmVhZExpbmUgZG9lcyBub3QgaW5jbHVkZSB0aGUgbGluZSBlbmQgKFwiXFxyXFxuXCIgb3JcbiAgICogXCJcXG5cIikuXG4gICAqXG4gICAqIFdoZW4gdGhlIGVuZCBvZiB0aGUgdW5kZXJseWluZyBzdHJlYW0gaXMgcmVhY2hlZCwgdGhlIGZpbmFsIGJ5dGVzIGluIHRoZVxuICAgKiBzdHJlYW0gYXJlIHJldHVybmVkLiBObyBpbmRpY2F0aW9uIG9yIGVycm9yIGlzIGdpdmVuIGlmIHRoZSBpbnB1dCBlbmRzXG4gICAqIHdpdGhvdXQgYSBmaW5hbCBsaW5lIGVuZC4gV2hlbiB0aGVyZSBhcmUgbm8gbW9yZSB0cmFpbGluZyBieXRlcyB0byByZWFkLFxuICAgKiBgcmVhZExpbmUoKWAgcmV0dXJucyBgbnVsbGAuXG4gICAqXG4gICAqIENhbGxpbmcgYHVucmVhZEJ5dGUoKWAgYWZ0ZXIgYHJlYWRMaW5lKClgIHdpbGwgYWx3YXlzIHVucmVhZCB0aGUgbGFzdCBieXRlXG4gICAqIHJlYWQgKHBvc3NpYmx5IGEgY2hhcmFjdGVyIGJlbG9uZ2luZyB0byB0aGUgbGluZSBlbmQpIGV2ZW4gaWYgdGhhdCBieXRlIGlzXG4gICAqIG5vdCBwYXJ0IG9mIHRoZSBsaW5lIHJldHVybmVkIGJ5IGByZWFkTGluZSgpYC5cbiAgICovXG4gIGFzeW5jIHJlYWRMaW5lKCk6IFByb21pc2U8UmVhZExpbmVSZXN1bHQgfCBudWxsPiB7XG4gICAgbGV0IGxpbmU6IFVpbnQ4QXJyYXkgfCBudWxsO1xuXG4gICAgdHJ5IHtcbiAgICAgIGxpbmUgPSBhd2FpdCB0aGlzLnJlYWRTbGljZShMRik7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBsZXQgeyBwYXJ0aWFsIH0gPSBlcnI7XG4gICAgICBhc3NlcnQoXG4gICAgICAgIHBhcnRpYWwgaW5zdGFuY2VvZiBVaW50OEFycmF5LFxuICAgICAgICBcImJ1ZmlvOiBjYXVnaHQgZXJyb3IgZnJvbSBgcmVhZFNsaWNlKClgIHdpdGhvdXQgYHBhcnRpYWxgIHByb3BlcnR5XCIsXG4gICAgICApO1xuXG4gICAgICAvLyBEb24ndCB0aHJvdyBpZiBgcmVhZFNsaWNlKClgIGZhaWxlZCB3aXRoIGBCdWZmZXJGdWxsRXJyb3JgLCBpbnN0ZWFkIHdlXG4gICAgICAvLyBqdXN0IHJldHVybiB3aGF0ZXZlciBpcyBhdmFpbGFibGUgYW5kIHNldCB0aGUgYG1vcmVgIGZsYWcuXG4gICAgICBpZiAoIShlcnIgaW5zdGFuY2VvZiBCdWZmZXJGdWxsRXJyb3IpKSB7XG4gICAgICAgIHRocm93IGVycjtcbiAgICAgIH1cblxuICAgICAgLy8gSGFuZGxlIHRoZSBjYXNlIHdoZXJlIFwiXFxyXFxuXCIgc3RyYWRkbGVzIHRoZSBidWZmZXIuXG4gICAgICBpZiAoXG4gICAgICAgICF0aGlzLmVvZiAmJlxuICAgICAgICBwYXJ0aWFsLmJ5dGVMZW5ndGggPiAwICYmXG4gICAgICAgIHBhcnRpYWxbcGFydGlhbC5ieXRlTGVuZ3RoIC0gMV0gPT09IENSXG4gICAgICApIHtcbiAgICAgICAgLy8gUHV0IHRoZSAnXFxyJyBiYWNrIG9uIGJ1ZiBhbmQgZHJvcCBpdCBmcm9tIGxpbmUuXG4gICAgICAgIC8vIExldCB0aGUgbmV4dCBjYWxsIHRvIFJlYWRMaW5lIGNoZWNrIGZvciBcIlxcclxcblwiLlxuICAgICAgICBhc3NlcnQodGhpcy5yID4gMCwgXCJidWZpbzogdHJpZWQgdG8gcmV3aW5kIHBhc3Qgc3RhcnQgb2YgYnVmZmVyXCIpO1xuICAgICAgICB0aGlzLnItLTtcbiAgICAgICAgcGFydGlhbCA9IHBhcnRpYWwuc3ViYXJyYXkoMCwgcGFydGlhbC5ieXRlTGVuZ3RoIC0gMSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB7IGxpbmU6IHBhcnRpYWwsIG1vcmU6ICF0aGlzLmVvZiB9O1xuICAgIH1cblxuICAgIGlmIChsaW5lID09PSBudWxsKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBpZiAobGluZS5ieXRlTGVuZ3RoID09PSAwKSB7XG4gICAgICByZXR1cm4geyBsaW5lLCBtb3JlOiBmYWxzZSB9O1xuICAgIH1cblxuICAgIGlmIChsaW5lW2xpbmUuYnl0ZUxlbmd0aCAtIDFdID09IExGKSB7XG4gICAgICBsZXQgZHJvcCA9IDE7XG4gICAgICBpZiAobGluZS5ieXRlTGVuZ3RoID4gMSAmJiBsaW5lW2xpbmUuYnl0ZUxlbmd0aCAtIDJdID09PSBDUikge1xuICAgICAgICBkcm9wID0gMjtcbiAgICAgIH1cbiAgICAgIGxpbmUgPSBsaW5lLnN1YmFycmF5KDAsIGxpbmUuYnl0ZUxlbmd0aCAtIGRyb3ApO1xuICAgIH1cbiAgICByZXR1cm4geyBsaW5lLCBtb3JlOiBmYWxzZSB9O1xuICB9XG5cbiAgLyoqIGByZWFkU2xpY2UoKWAgcmVhZHMgdW50aWwgdGhlIGZpcnN0IG9jY3VycmVuY2Ugb2YgYGRlbGltYCBpbiB0aGUgaW5wdXQsXG4gICAqIHJldHVybmluZyBhIHNsaWNlIHBvaW50aW5nIGF0IHRoZSBieXRlcyBpbiB0aGUgYnVmZmVyLiBUaGUgYnl0ZXMgc3RvcFxuICAgKiBiZWluZyB2YWxpZCBhdCB0aGUgbmV4dCByZWFkLlxuICAgKlxuICAgKiBJZiBgcmVhZFNsaWNlKClgIGVuY291bnRlcnMgYW4gZXJyb3IgYmVmb3JlIGZpbmRpbmcgYSBkZWxpbWl0ZXIsIG9yIHRoZVxuICAgKiBidWZmZXIgZmlsbHMgd2l0aG91dCBmaW5kaW5nIGEgZGVsaW1pdGVyLCBpdCB0aHJvd3MgYW4gZXJyb3Igd2l0aCBhXG4gICAqIGBwYXJ0aWFsYCBwcm9wZXJ0eSB0aGF0IGNvbnRhaW5zIHRoZSBlbnRpcmUgYnVmZmVyLlxuICAgKlxuICAgKiBJZiBgcmVhZFNsaWNlKClgIGVuY291bnRlcnMgdGhlIGVuZCBvZiB0aGUgdW5kZXJseWluZyBzdHJlYW0gYW5kIHRoZXJlIGFyZVxuICAgKiBhbnkgYnl0ZXMgbGVmdCBpbiB0aGUgYnVmZmVyLCB0aGUgcmVzdCBvZiB0aGUgYnVmZmVyIGlzIHJldHVybmVkLiBJbiBvdGhlclxuICAgKiB3b3JkcywgRU9GIGlzIGFsd2F5cyB0cmVhdGVkIGFzIGEgZGVsaW1pdGVyLiBPbmNlIHRoZSBidWZmZXIgaXMgZW1wdHksXG4gICAqIGl0IHJldHVybnMgYG51bGxgLlxuICAgKlxuICAgKiBCZWNhdXNlIHRoZSBkYXRhIHJldHVybmVkIGZyb20gYHJlYWRTbGljZSgpYCB3aWxsIGJlIG92ZXJ3cml0dGVuIGJ5IHRoZVxuICAgKiBuZXh0IEkvTyBvcGVyYXRpb24sIG1vc3QgY2xpZW50cyBzaG91bGQgdXNlIGByZWFkU3RyaW5nKClgIGluc3RlYWQuXG4gICAqL1xuICBhc3luYyByZWFkU2xpY2UoZGVsaW06IG51bWJlcik6IFByb21pc2U8VWludDhBcnJheSB8IG51bGw+IHtcbiAgICBsZXQgcyA9IDA7IC8vIHNlYXJjaCBzdGFydCBpbmRleFxuICAgIGxldCBzbGljZTogVWludDhBcnJheSB8IHVuZGVmaW5lZDtcblxuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICAvLyBTZWFyY2ggYnVmZmVyLlxuICAgICAgbGV0IGkgPSB0aGlzLmJ1Zi5zdWJhcnJheSh0aGlzLnIgKyBzLCB0aGlzLncpLmluZGV4T2YoZGVsaW0pO1xuICAgICAgaWYgKGkgPj0gMCkge1xuICAgICAgICBpICs9IHM7XG4gICAgICAgIHNsaWNlID0gdGhpcy5idWYuc3ViYXJyYXkodGhpcy5yLCB0aGlzLnIgKyBpICsgMSk7XG4gICAgICAgIHRoaXMuciArPSBpICsgMTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIC8vIEVPRj9cbiAgICAgIGlmICh0aGlzLmVvZikge1xuICAgICAgICBpZiAodGhpcy5yID09PSB0aGlzLncpIHtcbiAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfVxuICAgICAgICBzbGljZSA9IHRoaXMuYnVmLnN1YmFycmF5KHRoaXMuciwgdGhpcy53KTtcbiAgICAgICAgdGhpcy5yID0gdGhpcy53O1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgLy8gQnVmZmVyIGZ1bGw/XG4gICAgICBpZiAodGhpcy5idWZmZXJlZCgpID49IHRoaXMuYnVmLmJ5dGVMZW5ndGgpIHtcbiAgICAgICAgdGhpcy5yID0gdGhpcy53O1xuICAgICAgICAvLyAjNDUyMSBUaGUgaW50ZXJuYWwgYnVmZmVyIHNob3VsZCBub3QgYmUgcmV1c2VkIGFjcm9zcyByZWFkcyBiZWNhdXNlIGl0IGNhdXNlcyBjb3JydXB0aW9uIG9mIGRhdGEuXG4gICAgICAgIGNvbnN0IG9sZGJ1ZiA9IHRoaXMuYnVmO1xuICAgICAgICBjb25zdCBuZXdidWYgPSB0aGlzLmJ1Zi5zbGljZSgwKTtcbiAgICAgICAgdGhpcy5idWYgPSBuZXdidWY7XG4gICAgICAgIHRocm93IG5ldyBCdWZmZXJGdWxsRXJyb3Iob2xkYnVmKTtcbiAgICAgIH1cblxuICAgICAgcyA9IHRoaXMudyAtIHRoaXMucjsgLy8gZG8gbm90IHJlc2NhbiBhcmVhIHdlIHNjYW5uZWQgYmVmb3JlXG5cbiAgICAgIC8vIEJ1ZmZlciBpcyBub3QgZnVsbC5cbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHRoaXMuX2ZpbGwoKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBlcnIucGFydGlhbCA9IHNsaWNlO1xuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gSGFuZGxlIGxhc3QgYnl0ZSwgaWYgYW55LlxuICAgIC8vIGNvbnN0IGkgPSBzbGljZS5ieXRlTGVuZ3RoIC0gMTtcbiAgICAvLyBpZiAoaSA+PSAwKSB7XG4gICAgLy8gICB0aGlzLmxhc3RCeXRlID0gc2xpY2VbaV07XG4gICAgLy8gICB0aGlzLmxhc3RDaGFyU2l6ZSA9IC0xXG4gICAgLy8gfVxuXG4gICAgcmV0dXJuIHNsaWNlO1xuICB9XG5cbiAgLyoqIGBwZWVrKClgIHJldHVybnMgdGhlIG5leHQgYG5gIGJ5dGVzIHdpdGhvdXQgYWR2YW5jaW5nIHRoZSByZWFkZXIuIFRoZVxuICAgKiBieXRlcyBzdG9wIGJlaW5nIHZhbGlkIGF0IHRoZSBuZXh0IHJlYWQgY2FsbC5cbiAgICpcbiAgICogV2hlbiB0aGUgZW5kIG9mIHRoZSB1bmRlcmx5aW5nIHN0cmVhbSBpcyByZWFjaGVkLCBidXQgdGhlcmUgYXJlIHVucmVhZFxuICAgKiBieXRlcyBsZWZ0IGluIHRoZSBidWZmZXIsIHRob3NlIGJ5dGVzIGFyZSByZXR1cm5lZC4gSWYgdGhlcmUgYXJlIG5vIGJ5dGVzXG4gICAqIGxlZnQgaW4gdGhlIGJ1ZmZlciwgaXQgcmV0dXJucyBgbnVsbGAuXG4gICAqXG4gICAqIElmIGFuIGVycm9yIGlzIGVuY291bnRlcmVkIGJlZm9yZSBgbmAgYnl0ZXMgYXJlIGF2YWlsYWJsZSwgYHBlZWsoKWAgdGhyb3dzXG4gICAqIGFuIGVycm9yIHdpdGggdGhlIGBwYXJ0aWFsYCBwcm9wZXJ0eSBzZXQgdG8gYSBzbGljZSBvZiB0aGUgYnVmZmVyIHRoYXRcbiAgICogY29udGFpbnMgdGhlIGJ5dGVzIHRoYXQgd2VyZSBhdmFpbGFibGUgYmVmb3JlIHRoZSBlcnJvciBvY2N1cnJlZC5cbiAgICovXG4gIGFzeW5jIHBlZWsobjogbnVtYmVyKTogUHJvbWlzZTxVaW50OEFycmF5IHwgbnVsbD4ge1xuICAgIGlmIChuIDwgMCkge1xuICAgICAgdGhyb3cgRXJyb3IoXCJuZWdhdGl2ZSBjb3VudFwiKTtcbiAgICB9XG5cbiAgICBsZXQgYXZhaWwgPSB0aGlzLncgLSB0aGlzLnI7XG4gICAgd2hpbGUgKGF2YWlsIDwgbiAmJiBhdmFpbCA8IHRoaXMuYnVmLmJ5dGVMZW5ndGggJiYgIXRoaXMuZW9mKSB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCB0aGlzLl9maWxsKCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgZXJyLnBhcnRpYWwgPSB0aGlzLmJ1Zi5zdWJhcnJheSh0aGlzLnIsIHRoaXMudyk7XG4gICAgICAgIHRocm93IGVycjtcbiAgICAgIH1cbiAgICAgIGF2YWlsID0gdGhpcy53IC0gdGhpcy5yO1xuICAgIH1cblxuICAgIGlmIChhdmFpbCA9PT0gMCAmJiB0aGlzLmVvZikge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfSBlbHNlIGlmIChhdmFpbCA8IG4gJiYgdGhpcy5lb2YpIHtcbiAgICAgIHJldHVybiB0aGlzLmJ1Zi5zdWJhcnJheSh0aGlzLnIsIHRoaXMuciArIGF2YWlsKTtcbiAgICB9IGVsc2UgaWYgKGF2YWlsIDwgbikge1xuICAgICAgdGhyb3cgbmV3IEJ1ZmZlckZ1bGxFcnJvcih0aGlzLmJ1Zi5zdWJhcnJheSh0aGlzLnIsIHRoaXMudykpO1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzLmJ1Zi5zdWJhcnJheSh0aGlzLnIsIHRoaXMuciArIG4pO1xuICB9XG59XG5cbmFic3RyYWN0IGNsYXNzIEFic3RyYWN0QnVmQmFzZSB7XG4gIGJ1ZiE6IFVpbnQ4QXJyYXk7XG4gIHVzZWRCdWZmZXJCeXRlcyA9IDA7XG4gIGVycjogRXJyb3IgfCBudWxsID0gbnVsbDtcblxuICAvKiogU2l6ZSByZXR1cm5zIHRoZSBzaXplIG9mIHRoZSB1bmRlcmx5aW5nIGJ1ZmZlciBpbiBieXRlcy4gKi9cbiAgc2l6ZSgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLmJ1Zi5ieXRlTGVuZ3RoO1xuICB9XG5cbiAgLyoqIFJldHVybnMgaG93IG1hbnkgYnl0ZXMgYXJlIHVudXNlZCBpbiB0aGUgYnVmZmVyLiAqL1xuICBhdmFpbGFibGUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5idWYuYnl0ZUxlbmd0aCAtIHRoaXMudXNlZEJ1ZmZlckJ5dGVzO1xuICB9XG5cbiAgLyoqIGJ1ZmZlcmVkIHJldHVybnMgdGhlIG51bWJlciBvZiBieXRlcyB0aGF0IGhhdmUgYmVlbiB3cml0dGVuIGludG8gdGhlXG4gICAqIGN1cnJlbnQgYnVmZmVyLlxuICAgKi9cbiAgYnVmZmVyZWQoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy51c2VkQnVmZmVyQnl0ZXM7XG4gIH1cbn1cblxuLyoqIEJ1ZldyaXRlciBpbXBsZW1lbnRzIGJ1ZmZlcmluZyBmb3IgYW4gZGVuby5Xcml0ZXIgb2JqZWN0LlxuICogSWYgYW4gZXJyb3Igb2NjdXJzIHdyaXRpbmcgdG8gYSBXcml0ZXIsIG5vIG1vcmUgZGF0YSB3aWxsIGJlXG4gKiBhY2NlcHRlZCBhbmQgYWxsIHN1YnNlcXVlbnQgd3JpdGVzLCBhbmQgZmx1c2goKSwgd2lsbCByZXR1cm4gdGhlIGVycm9yLlxuICogQWZ0ZXIgYWxsIGRhdGEgaGFzIGJlZW4gd3JpdHRlbiwgdGhlIGNsaWVudCBzaG91bGQgY2FsbCB0aGVcbiAqIGZsdXNoKCkgbWV0aG9kIHRvIGd1YXJhbnRlZSBhbGwgZGF0YSBoYXMgYmVlbiBmb3J3YXJkZWQgdG9cbiAqIHRoZSB1bmRlcmx5aW5nIGRlbm8uV3JpdGVyLlxuICovXG5leHBvcnQgY2xhc3MgQnVmV3JpdGVyIGV4dGVuZHMgQWJzdHJhY3RCdWZCYXNlIGltcGxlbWVudHMgV3JpdGVyIHtcbiAgLyoqIHJldHVybiBuZXcgQnVmV3JpdGVyIHVubGVzcyB3cml0ZXIgaXMgQnVmV3JpdGVyICovXG4gIHN0YXRpYyBjcmVhdGUod3JpdGVyOiBXcml0ZXIsIHNpemU6IG51bWJlciA9IERFRkFVTFRfQlVGX1NJWkUpOiBCdWZXcml0ZXIge1xuICAgIHJldHVybiB3cml0ZXIgaW5zdGFuY2VvZiBCdWZXcml0ZXIgPyB3cml0ZXIgOiBuZXcgQnVmV3JpdGVyKHdyaXRlciwgc2l6ZSk7XG4gIH1cblxuICBjb25zdHJ1Y3Rvcihwcml2YXRlIHdyaXRlcjogV3JpdGVyLCBzaXplOiBudW1iZXIgPSBERUZBVUxUX0JVRl9TSVpFKSB7XG4gICAgc3VwZXIoKTtcbiAgICBpZiAoc2l6ZSA8PSAwKSB7XG4gICAgICBzaXplID0gREVGQVVMVF9CVUZfU0laRTtcbiAgICB9XG4gICAgdGhpcy5idWYgPSBuZXcgVWludDhBcnJheShzaXplKTtcbiAgfVxuXG4gIC8qKiBEaXNjYXJkcyBhbnkgdW5mbHVzaGVkIGJ1ZmZlcmVkIGRhdGEsIGNsZWFycyBhbnkgZXJyb3IsIGFuZFxuICAgKiByZXNldHMgYnVmZmVyIHRvIHdyaXRlIGl0cyBvdXRwdXQgdG8gdy5cbiAgICovXG4gIHJlc2V0KHc6IFdyaXRlcik6IHZvaWQge1xuICAgIHRoaXMuZXJyID0gbnVsbDtcbiAgICB0aGlzLnVzZWRCdWZmZXJCeXRlcyA9IDA7XG4gICAgdGhpcy53cml0ZXIgPSB3O1xuICB9XG5cbiAgLyoqIEZsdXNoIHdyaXRlcyBhbnkgYnVmZmVyZWQgZGF0YSB0byB0aGUgdW5kZXJseWluZyBpby5Xcml0ZXIuICovXG4gIGFzeW5jIGZsdXNoKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICh0aGlzLmVyciAhPT0gbnVsbCkgdGhyb3cgdGhpcy5lcnI7XG4gICAgaWYgKHRoaXMudXNlZEJ1ZmZlckJ5dGVzID09PSAwKSByZXR1cm47XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgRGVuby53cml0ZUFsbChcbiAgICAgICAgdGhpcy53cml0ZXIsXG4gICAgICAgIHRoaXMuYnVmLnN1YmFycmF5KDAsIHRoaXMudXNlZEJ1ZmZlckJ5dGVzKSxcbiAgICAgICk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgdGhpcy5lcnIgPSBlO1xuICAgICAgdGhyb3cgZTtcbiAgICB9XG5cbiAgICB0aGlzLmJ1ZiA9IG5ldyBVaW50OEFycmF5KHRoaXMuYnVmLmxlbmd0aCk7XG4gICAgdGhpcy51c2VkQnVmZmVyQnl0ZXMgPSAwO1xuICB9XG5cbiAgLyoqIFdyaXRlcyB0aGUgY29udGVudHMgb2YgYGRhdGFgIGludG8gdGhlIGJ1ZmZlci4gIElmIHRoZSBjb250ZW50cyB3b24ndCBmdWxseVxuICAgKiBmaXQgaW50byB0aGUgYnVmZmVyLCB0aG9zZSBieXRlcyB0aGF0IGNhbiBhcmUgY29waWVkIGludG8gdGhlIGJ1ZmZlciwgdGhlXG4gICAqIGJ1ZmZlciBpcyB0aGUgZmx1c2hlZCB0byB0aGUgd3JpdGVyIGFuZCB0aGUgcmVtYWluaW5nIGJ5dGVzIGFyZSBjb3BpZWQgaW50b1xuICAgKiB0aGUgbm93IGVtcHR5IGJ1ZmZlci5cbiAgICpcbiAgICogQHJldHVybiB0aGUgbnVtYmVyIG9mIGJ5dGVzIHdyaXR0ZW4gdG8gdGhlIGJ1ZmZlci5cbiAgICovXG4gIGFzeW5jIHdyaXRlKGRhdGE6IFVpbnQ4QXJyYXkpOiBQcm9taXNlPG51bWJlcj4ge1xuICAgIGlmICh0aGlzLmVyciAhPT0gbnVsbCkgdGhyb3cgdGhpcy5lcnI7XG4gICAgaWYgKGRhdGEubGVuZ3RoID09PSAwKSByZXR1cm4gMDtcblxuICAgIGxldCB0b3RhbEJ5dGVzV3JpdHRlbiA9IDA7XG4gICAgbGV0IG51bUJ5dGVzV3JpdHRlbiA9IDA7XG4gICAgd2hpbGUgKGRhdGEuYnl0ZUxlbmd0aCA+IHRoaXMuYXZhaWxhYmxlKCkpIHtcbiAgICAgIGlmICh0aGlzLmJ1ZmZlcmVkKCkgPT09IDApIHtcbiAgICAgICAgLy8gTGFyZ2Ugd3JpdGUsIGVtcHR5IGJ1ZmZlci5cbiAgICAgICAgLy8gV3JpdGUgZGlyZWN0bHkgZnJvbSBkYXRhIHRvIGF2b2lkIGNvcHkuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgbnVtQnl0ZXNXcml0dGVuID0gYXdhaXQgdGhpcy53cml0ZXIud3JpdGUoZGF0YSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICB0aGlzLmVyciA9IGU7XG4gICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbnVtQnl0ZXNXcml0dGVuID0gY29weShkYXRhLCB0aGlzLmJ1ZiwgdGhpcy51c2VkQnVmZmVyQnl0ZXMpO1xuICAgICAgICB0aGlzLnVzZWRCdWZmZXJCeXRlcyArPSBudW1CeXRlc1dyaXR0ZW47XG4gICAgICAgIGF3YWl0IHRoaXMuZmx1c2goKTtcbiAgICAgIH1cbiAgICAgIHRvdGFsQnl0ZXNXcml0dGVuICs9IG51bUJ5dGVzV3JpdHRlbjtcbiAgICAgIGRhdGEgPSBkYXRhLnN1YmFycmF5KG51bUJ5dGVzV3JpdHRlbik7XG4gICAgfVxuXG4gICAgbnVtQnl0ZXNXcml0dGVuID0gY29weShkYXRhLCB0aGlzLmJ1ZiwgdGhpcy51c2VkQnVmZmVyQnl0ZXMpO1xuICAgIHRoaXMudXNlZEJ1ZmZlckJ5dGVzICs9IG51bUJ5dGVzV3JpdHRlbjtcbiAgICB0b3RhbEJ5dGVzV3JpdHRlbiArPSBudW1CeXRlc1dyaXR0ZW47XG4gICAgcmV0dXJuIHRvdGFsQnl0ZXNXcml0dGVuO1xuICB9XG59XG5cbi8qKiBCdWZXcml0ZXJTeW5jIGltcGxlbWVudHMgYnVmZmVyaW5nIGZvciBhIGRlbm8uV3JpdGVyU3luYyBvYmplY3QuXG4gKiBJZiBhbiBlcnJvciBvY2N1cnMgd3JpdGluZyB0byBhIFdyaXRlclN5bmMsIG5vIG1vcmUgZGF0YSB3aWxsIGJlXG4gKiBhY2NlcHRlZCBhbmQgYWxsIHN1YnNlcXVlbnQgd3JpdGVzLCBhbmQgZmx1c2goKSwgd2lsbCByZXR1cm4gdGhlIGVycm9yLlxuICogQWZ0ZXIgYWxsIGRhdGEgaGFzIGJlZW4gd3JpdHRlbiwgdGhlIGNsaWVudCBzaG91bGQgY2FsbCB0aGVcbiAqIGZsdXNoKCkgbWV0aG9kIHRvIGd1YXJhbnRlZSBhbGwgZGF0YSBoYXMgYmVlbiBmb3J3YXJkZWQgdG9cbiAqIHRoZSB1bmRlcmx5aW5nIGRlbm8uV3JpdGVyU3luYy5cbiAqL1xuZXhwb3J0IGNsYXNzIEJ1ZldyaXRlclN5bmMgZXh0ZW5kcyBBYnN0cmFjdEJ1ZkJhc2UgaW1wbGVtZW50cyBXcml0ZXJTeW5jIHtcbiAgLyoqIHJldHVybiBuZXcgQnVmV3JpdGVyU3luYyB1bmxlc3Mgd3JpdGVyIGlzIEJ1ZldyaXRlclN5bmMgKi9cbiAgc3RhdGljIGNyZWF0ZShcbiAgICB3cml0ZXI6IFdyaXRlclN5bmMsXG4gICAgc2l6ZTogbnVtYmVyID0gREVGQVVMVF9CVUZfU0laRSxcbiAgKTogQnVmV3JpdGVyU3luYyB7XG4gICAgcmV0dXJuIHdyaXRlciBpbnN0YW5jZW9mIEJ1ZldyaXRlclN5bmNcbiAgICAgID8gd3JpdGVyXG4gICAgICA6IG5ldyBCdWZXcml0ZXJTeW5jKHdyaXRlciwgc2l6ZSk7XG4gIH1cblxuICBjb25zdHJ1Y3Rvcihwcml2YXRlIHdyaXRlcjogV3JpdGVyU3luYywgc2l6ZTogbnVtYmVyID0gREVGQVVMVF9CVUZfU0laRSkge1xuICAgIHN1cGVyKCk7XG4gICAgaWYgKHNpemUgPD0gMCkge1xuICAgICAgc2l6ZSA9IERFRkFVTFRfQlVGX1NJWkU7XG4gICAgfVxuICAgIHRoaXMuYnVmID0gbmV3IFVpbnQ4QXJyYXkoc2l6ZSk7XG4gIH1cblxuICAvKiogRGlzY2FyZHMgYW55IHVuZmx1c2hlZCBidWZmZXJlZCBkYXRhLCBjbGVhcnMgYW55IGVycm9yLCBhbmRcbiAgICogcmVzZXRzIGJ1ZmZlciB0byB3cml0ZSBpdHMgb3V0cHV0IHRvIHcuXG4gICAqL1xuICByZXNldCh3OiBXcml0ZXJTeW5jKTogdm9pZCB7XG4gICAgdGhpcy5lcnIgPSBudWxsO1xuICAgIHRoaXMudXNlZEJ1ZmZlckJ5dGVzID0gMDtcbiAgICB0aGlzLndyaXRlciA9IHc7XG4gIH1cblxuICAvKiogRmx1c2ggd3JpdGVzIGFueSBidWZmZXJlZCBkYXRhIHRvIHRoZSB1bmRlcmx5aW5nIGlvLldyaXRlclN5bmMuICovXG4gIGZsdXNoKCk6IHZvaWQge1xuICAgIGlmICh0aGlzLmVyciAhPT0gbnVsbCkgdGhyb3cgdGhpcy5lcnI7XG4gICAgaWYgKHRoaXMudXNlZEJ1ZmZlckJ5dGVzID09PSAwKSByZXR1cm47XG5cbiAgICB0cnkge1xuICAgICAgRGVuby53cml0ZUFsbFN5bmMoXG4gICAgICAgIHRoaXMud3JpdGVyLFxuICAgICAgICB0aGlzLmJ1Zi5zdWJhcnJheSgwLCB0aGlzLnVzZWRCdWZmZXJCeXRlcyksXG4gICAgICApO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHRoaXMuZXJyID0gZTtcbiAgICAgIHRocm93IGU7XG4gICAgfVxuXG4gICAgdGhpcy5idWYgPSBuZXcgVWludDhBcnJheSh0aGlzLmJ1Zi5sZW5ndGgpO1xuICAgIHRoaXMudXNlZEJ1ZmZlckJ5dGVzID0gMDtcbiAgfVxuXG4gIC8qKiBXcml0ZXMgdGhlIGNvbnRlbnRzIG9mIGBkYXRhYCBpbnRvIHRoZSBidWZmZXIuICBJZiB0aGUgY29udGVudHMgd29uJ3QgZnVsbHlcbiAgICogZml0IGludG8gdGhlIGJ1ZmZlciwgdGhvc2UgYnl0ZXMgdGhhdCBjYW4gYXJlIGNvcGllZCBpbnRvIHRoZSBidWZmZXIsIHRoZVxuICAgKiBidWZmZXIgaXMgdGhlIGZsdXNoZWQgdG8gdGhlIHdyaXRlciBhbmQgdGhlIHJlbWFpbmluZyBieXRlcyBhcmUgY29waWVkIGludG9cbiAgICogdGhlIG5vdyBlbXB0eSBidWZmZXIuXG4gICAqXG4gICAqIEByZXR1cm4gdGhlIG51bWJlciBvZiBieXRlcyB3cml0dGVuIHRvIHRoZSBidWZmZXIuXG4gICAqL1xuICB3cml0ZVN5bmMoZGF0YTogVWludDhBcnJheSk6IG51bWJlciB7XG4gICAgaWYgKHRoaXMuZXJyICE9PSBudWxsKSB0aHJvdyB0aGlzLmVycjtcbiAgICBpZiAoZGF0YS5sZW5ndGggPT09IDApIHJldHVybiAwO1xuXG4gICAgbGV0IHRvdGFsQnl0ZXNXcml0dGVuID0gMDtcbiAgICBsZXQgbnVtQnl0ZXNXcml0dGVuID0gMDtcbiAgICB3aGlsZSAoZGF0YS5ieXRlTGVuZ3RoID4gdGhpcy5hdmFpbGFibGUoKSkge1xuICAgICAgaWYgKHRoaXMuYnVmZmVyZWQoKSA9PT0gMCkge1xuICAgICAgICAvLyBMYXJnZSB3cml0ZSwgZW1wdHkgYnVmZmVyLlxuICAgICAgICAvLyBXcml0ZSBkaXJlY3RseSBmcm9tIGRhdGEgdG8gYXZvaWQgY29weS5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBudW1CeXRlc1dyaXR0ZW4gPSB0aGlzLndyaXRlci53cml0ZVN5bmMoZGF0YSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICB0aGlzLmVyciA9IGU7XG4gICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbnVtQnl0ZXNXcml0dGVuID0gY29weShkYXRhLCB0aGlzLmJ1ZiwgdGhpcy51c2VkQnVmZmVyQnl0ZXMpO1xuICAgICAgICB0aGlzLnVzZWRCdWZmZXJCeXRlcyArPSBudW1CeXRlc1dyaXR0ZW47XG4gICAgICAgIHRoaXMuZmx1c2goKTtcbiAgICAgIH1cbiAgICAgIHRvdGFsQnl0ZXNXcml0dGVuICs9IG51bUJ5dGVzV3JpdHRlbjtcbiAgICAgIGRhdGEgPSBkYXRhLnN1YmFycmF5KG51bUJ5dGVzV3JpdHRlbik7XG4gICAgfVxuXG4gICAgbnVtQnl0ZXNXcml0dGVuID0gY29weShkYXRhLCB0aGlzLmJ1ZiwgdGhpcy51c2VkQnVmZmVyQnl0ZXMpO1xuICAgIHRoaXMudXNlZEJ1ZmZlckJ5dGVzICs9IG51bUJ5dGVzV3JpdHRlbjtcbiAgICB0b3RhbEJ5dGVzV3JpdHRlbiArPSBudW1CeXRlc1dyaXR0ZW47XG4gICAgcmV0dXJuIHRvdGFsQnl0ZXNXcml0dGVuO1xuICB9XG59XG5cbi8qKiBHZW5lcmF0ZSBsb25nZXN0IHByb3BlciBwcmVmaXggd2hpY2ggaXMgYWxzbyBzdWZmaXggYXJyYXkuICovXG5mdW5jdGlvbiBjcmVhdGVMUFMocGF0OiBVaW50OEFycmF5KTogVWludDhBcnJheSB7XG4gIGNvbnN0IGxwcyA9IG5ldyBVaW50OEFycmF5KHBhdC5sZW5ndGgpO1xuICBscHNbMF0gPSAwO1xuICBsZXQgcHJlZml4RW5kID0gMDtcbiAgbGV0IGkgPSAxO1xuICB3aGlsZSAoaSA8IGxwcy5sZW5ndGgpIHtcbiAgICBpZiAocGF0W2ldID09IHBhdFtwcmVmaXhFbmRdKSB7XG4gICAgICBwcmVmaXhFbmQrKztcbiAgICAgIGxwc1tpXSA9IHByZWZpeEVuZDtcbiAgICAgIGkrKztcbiAgICB9IGVsc2UgaWYgKHByZWZpeEVuZCA9PT0gMCkge1xuICAgICAgbHBzW2ldID0gMDtcbiAgICAgIGkrKztcbiAgICB9IGVsc2Uge1xuICAgICAgcHJlZml4RW5kID0gcGF0W3ByZWZpeEVuZCAtIDFdO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbHBzO1xufVxuXG4vKiogUmVhZCBkZWxpbWl0ZWQgYnl0ZXMgZnJvbSBhIFJlYWRlci4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiogcmVhZERlbGltKFxuICByZWFkZXI6IFJlYWRlcixcbiAgZGVsaW06IFVpbnQ4QXJyYXksXG4pOiBBc3luY0l0ZXJhYmxlSXRlcmF0b3I8VWludDhBcnJheT4ge1xuICAvLyBBdm9pZCB1bmljb2RlIHByb2JsZW1zXG4gIGNvbnN0IGRlbGltTGVuID0gZGVsaW0ubGVuZ3RoO1xuICBjb25zdCBkZWxpbUxQUyA9IGNyZWF0ZUxQUyhkZWxpbSk7XG5cbiAgbGV0IGlucHV0QnVmZmVyID0gbmV3IERlbm8uQnVmZmVyKCk7XG4gIGNvbnN0IGluc3BlY3RBcnIgPSBuZXcgVWludDhBcnJheShNYXRoLm1heCgxMDI0LCBkZWxpbUxlbiArIDEpKTtcblxuICAvLyBNb2RpZmllZCBLTVBcbiAgbGV0IGluc3BlY3RJbmRleCA9IDA7XG4gIGxldCBtYXRjaEluZGV4ID0gMDtcbiAgd2hpbGUgKHRydWUpIHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZWFkZXIucmVhZChpbnNwZWN0QXJyKTtcbiAgICBpZiAocmVzdWx0ID09PSBudWxsKSB7XG4gICAgICAvLyBZaWVsZCBsYXN0IGNodW5rLlxuICAgICAgeWllbGQgaW5wdXRCdWZmZXIuYnl0ZXMoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKChyZXN1bHQgYXMgbnVtYmVyKSA8IDApIHtcbiAgICAgIC8vIERpc2NhcmQgYWxsIHJlbWFpbmluZyBhbmQgc2lsZW50bHkgZmFpbC5cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3Qgc2xpY2VSZWFkID0gaW5zcGVjdEFyci5zdWJhcnJheSgwLCByZXN1bHQgYXMgbnVtYmVyKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlQWxsKGlucHV0QnVmZmVyLCBzbGljZVJlYWQpO1xuXG4gICAgbGV0IHNsaWNlVG9Qcm9jZXNzID0gaW5wdXRCdWZmZXIuYnl0ZXMoKTtcbiAgICB3aGlsZSAoaW5zcGVjdEluZGV4IDwgc2xpY2VUb1Byb2Nlc3MubGVuZ3RoKSB7XG4gICAgICBpZiAoc2xpY2VUb1Byb2Nlc3NbaW5zcGVjdEluZGV4XSA9PT0gZGVsaW1bbWF0Y2hJbmRleF0pIHtcbiAgICAgICAgaW5zcGVjdEluZGV4Kys7XG4gICAgICAgIG1hdGNoSW5kZXgrKztcbiAgICAgICAgaWYgKG1hdGNoSW5kZXggPT09IGRlbGltTGVuKSB7XG4gICAgICAgICAgLy8gRnVsbCBtYXRjaFxuICAgICAgICAgIGNvbnN0IG1hdGNoRW5kID0gaW5zcGVjdEluZGV4IC0gZGVsaW1MZW47XG4gICAgICAgICAgY29uc3QgcmVhZHlCeXRlcyA9IHNsaWNlVG9Qcm9jZXNzLnN1YmFycmF5KDAsIG1hdGNoRW5kKTtcbiAgICAgICAgICAvLyBDb3B5XG4gICAgICAgICAgY29uc3QgcGVuZGluZ0J5dGVzID0gc2xpY2VUb1Byb2Nlc3Muc2xpY2UoaW5zcGVjdEluZGV4KTtcbiAgICAgICAgICB5aWVsZCByZWFkeUJ5dGVzO1xuICAgICAgICAgIC8vIFJlc2V0IG1hdGNoLCBkaWZmZXJlbnQgZnJvbSBLTVAuXG4gICAgICAgICAgc2xpY2VUb1Byb2Nlc3MgPSBwZW5kaW5nQnl0ZXM7XG4gICAgICAgICAgaW5zcGVjdEluZGV4ID0gMDtcbiAgICAgICAgICBtYXRjaEluZGV4ID0gMDtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKG1hdGNoSW5kZXggPT09IDApIHtcbiAgICAgICAgICBpbnNwZWN0SW5kZXgrKztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBtYXRjaEluZGV4ID0gZGVsaW1MUFNbbWF0Y2hJbmRleCAtIDFdO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIC8vIEtlZXAgaW5zcGVjdEluZGV4IGFuZCBtYXRjaEluZGV4LlxuICAgIGlucHV0QnVmZmVyID0gbmV3IERlbm8uQnVmZmVyKHNsaWNlVG9Qcm9jZXNzKTtcbiAgfVxufVxuXG4vKiogUmVhZCBkZWxpbWl0ZWQgc3RyaW5ncyBmcm9tIGEgUmVhZGVyLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uKiByZWFkU3RyaW5nRGVsaW0oXG4gIHJlYWRlcjogUmVhZGVyLFxuICBkZWxpbTogc3RyaW5nLFxuKTogQXN5bmNJdGVyYWJsZUl0ZXJhdG9yPHN0cmluZz4ge1xuICBjb25zdCBlbmNvZGVyID0gbmV3IFRleHRFbmNvZGVyKCk7XG4gIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgZm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiByZWFkRGVsaW0ocmVhZGVyLCBlbmNvZGVyLmVuY29kZShkZWxpbSkpKSB7XG4gICAgeWllbGQgZGVjb2Rlci5kZWNvZGUoY2h1bmspO1xuICB9XG59XG5cbi8qKiBSZWFkIHN0cmluZ3MgbGluZS1ieS1saW5lIGZyb20gYSBSZWFkZXIuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24qIHJlYWRMaW5lcyhcbiAgcmVhZGVyOiBSZWFkZXIsXG4pOiBBc3luY0l0ZXJhYmxlSXRlcmF0b3I8c3RyaW5nPiB7XG4gIGZvciBhd2FpdCAobGV0IGNodW5rIG9mIHJlYWRTdHJpbmdEZWxpbShyZWFkZXIsIFwiXFxuXCIpKSB7XG4gICAgLy8gRmluZGluZyBhIENSIGF0IHRoZSBlbmQgb2YgdGhlIGxpbmUgaXMgZXZpZGVuY2Ugb2YgYVxuICAgIC8vIFwiXFxyXFxuXCIgYXQgdGhlIGVuZCBvZiB0aGUgbGluZS4gVGhlIFwiXFxyXCIgcGFydCBzaG91bGQgYmVcbiAgICAvLyByZW1vdmVkIHRvby5cbiAgICBpZiAoY2h1bmsuZW5kc1dpdGgoXCJcXHJcIikpIHtcbiAgICAgIGNodW5rID0gY2h1bmsuc2xpY2UoMCwgLTEpO1xuICAgIH1cbiAgICB5aWVsZCBjaHVuaztcbiAgfVxufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJTQVNBLElBQUEsU0FBQSxlQUFBO1NBQ0EsTUFBQSxTQUFBLGtCQUFBO01BRUEsZ0JBQUEsR0FBQSxJQUFBO01BQ0EsWUFBQSxHQUFBLEVBQUE7TUFDQSwyQkFBQSxHQUFBLEdBQUE7TUFDQSxFQUFBLElBQUEsRUFBQSxFQUFBLFVBQUEsQ0FBQSxDQUFBO01BQ0EsRUFBQSxJQUFBLEVBQUEsRUFBQSxVQUFBLENBQUEsQ0FBQTthQUVBLGVBQUEsU0FBQSxLQUFBO0FBQ0EsUUFBQSxJQUFBLGVBQUE7Z0JBQ0EsT0FBQTtBQUNBLGFBQUEsRUFBQSxXQUFBO2FBREEsT0FBQSxHQUFBLE9BQUE7OzthQUtBLGdCQUFBLFNBQUEsSUFBQSxDQUFBLE1BQUEsQ0FBQSxhQUFBO0FBQ0EsUUFBQSxJQUFBLGdCQUFBOztBQUdBLGFBQUEsRUFBQSxtREFBQTs7O0FBVUEsRUFBQSxzREFBQSxFQUFBLGNBQ0EsU0FBQTtBQUdBLEtBQUEsR0FBQSxDQUFBO0FBQ0EsS0FBQSxHQUFBLENBQUE7QUFDQSxPQUFBLEdBQUEsS0FBQTtBQUNBLE1BQUEsMEJBQUE7QUFDQSxNQUFBLDhCQUFBO0FBRUEsTUFBQSw2Q0FBQSxFQUFBLFFBQ0EsTUFBQSxDQUFBLENBQUEsRUFBQSxJQUFBLEdBQUEsZ0JBQUE7ZUFDQSxDQUFBLFlBQUEsU0FBQSxHQUFBLENBQUEsT0FBQSxTQUFB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