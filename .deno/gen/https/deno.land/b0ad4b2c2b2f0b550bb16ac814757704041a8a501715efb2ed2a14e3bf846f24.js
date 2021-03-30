// Copyright 2018-2021 the Deno authors. All rights reserved. MIT license.
import { encode } from "../encoding/utf8.ts";
import { BufReader, BufWriter } from "../io/bufio.ts";
import { assert } from "../_util/assert.ts";
import { deferred, MuxAsyncIterator } from "../async/mod.ts";
import { bodyReader, chunkedBodyReader, emptyReader, readRequest, writeResponse } from "./_io.ts";
export class ServerRequest {
    #done=deferred();
    #contentLength=undefined;
    #body=undefined;
    #finalized=false;
    get done() {
        return this.#done.then((e)=>e
        );
    }
    /**
   * Value of Content-Length header.
   * If null, then content length is invalid or not given (e.g. chunked encoding).
   */ get contentLength() {
        // undefined means not cached.
        // null means invalid or not provided.
        if (this.#contentLength === undefined) {
            const cl = this.headers.get("content-length");
            if (cl) {
                this.#contentLength = parseInt(cl);
                // Convert NaN to null (as NaN harder to test)
                if (Number.isNaN(this.#contentLength)) {
                    this.#contentLength = null;
                }
            } else {
                this.#contentLength = null;
            }
        }
        return this.#contentLength;
    }
    /**
   * Body of the request.  The easiest way to consume the body is:
   *
   *     const buf: Uint8Array = await Deno.readAll(req.body);
   */ get body() {
        if (!this.#body) {
            if (this.contentLength != null) {
                this.#body = bodyReader(this.contentLength, this.r);
            } else {
                const transferEncoding = this.headers.get("transfer-encoding");
                if (transferEncoding != null) {
                    const parts = transferEncoding.split(",").map((e)=>e.trim().toLowerCase()
                    );
                    assert(parts.includes("chunked"), 'transfer-encoding must include "chunked" if content-length is not set');
                    this.#body = chunkedBodyReader(this.headers, this.r);
                } else {
                    // Neither content-length nor transfer-encoding: chunked
                    this.#body = emptyReader();
                }
            }
        }
        return this.#body;
    }
    async respond(r) {
        let err;
        try {
            // Write our response!
            await writeResponse(this.w, r);
        } catch (e) {
            try {
                // Eagerly close on error.
                this.conn.close();
            } catch  {
            }
            err = e;
        }
        // Signal that this request has been processed and the next pipelined
        // request on the same connection can be accepted.
        this.#done.resolve(err);
        if (err) {
            // Error during responding, rethrow.
            throw err;
        }
    }
    async finalize() {
        if (this.#finalized) return;
        // Consume unread body
        const body = this.body;
        const buf = new Uint8Array(1024);
        while(await body.read(buf) !== null){
        }
        this.#finalized = true;
    }
}
export class Server {
    #closing=false;
    #connections=[];
    constructor(listener){
        this.listener = listener;
    }
    close() {
        this.#closing = true;
        this.listener.close();
        for (const conn of this.#connections){
            try {
                conn.close();
            } catch (e) {
                // Connection might have been already closed
                if (!(e instanceof Deno.errors.BadResource)) {
                    throw e;
                }
            }
        }
    }
    // Yields all HTTP requests on a single TCP connection.
    async *iterateHttpRequests(conn) {
        const reader = new BufReader(conn);
        const writer = new BufWriter(conn);
        while(!this.#closing){
            let request;
            try {
                request = await readRequest(conn, reader);
            } catch (error) {
                if (error instanceof Deno.errors.InvalidData || error instanceof Deno.errors.UnexpectedEof) {
                    // An error was thrown while parsing request headers.
                    // Try to send the "400 Bad Request" before closing the connection.
                    try {
                        await writeResponse(writer, {
                            status: 400,
                            body: encode(`${error.message}\r\n\r\n`)
                        });
                    } catch (error) {
                    }
                }
                break;
            }
            if (request === null) {
                break;
            }
            request.w = writer;
            yield request;
            // Wait for the request to be processed before we accept a new request on
            // this connection.
            const responseError = await request.done;
            if (responseError) {
                // Something bad happened during response.
                // (likely other side closed during pipelined req)
                // req.done implies this connection already closed, so we can just return.
                this.untrackConnection(request.conn);
                return;
            }
            try {
                // Consume unread body and trailers if receiver didn't consume those data
                await request.finalize();
            } catch (error) {
                break;
            }
        }
        this.untrackConnection(conn);
        try {
            conn.close();
        } catch (e) {
        }
    }
    trackConnection(conn) {
        this.#connections.push(conn);
    }
    untrackConnection(conn) {
        const index = this.#connections.indexOf(conn);
        if (index !== -1) {
            this.#connections.splice(index, 1);
        }
    }
    // Accepts a new TCP connection and yields all HTTP requests that arrive on
    // it. When a connection is accepted, it also creates a new iterator of the
    // same kind and adds it to the request multiplexer so that another TCP
    // connection can be accepted.
    async *acceptConnAndIterateHttpRequests(mux) {
        if (this.#closing) return;
        // Wait for a new connection.
        let conn;
        try {
            conn = await this.listener.accept();
        } catch (error) {
            if (// The listener is closed:
            error instanceof Deno.errors.BadResource || // TLS handshake errors:
            error instanceof Deno.errors.InvalidData || error instanceof Deno.errors.UnexpectedEof || error instanceof Deno.errors.ConnectionReset) {
                return mux.add(this.acceptConnAndIterateHttpRequests(mux));
            }
            throw error;
        }
        this.trackConnection(conn);
        // Try to accept another connection and add it to the multiplexer.
        mux.add(this.acceptConnAndIterateHttpRequests(mux));
        // Yield the requests that arrive on the just-accepted connection.
        yield* this.iterateHttpRequests(conn);
    }
    [Symbol.asyncIterator]() {
        const mux = new MuxAsyncIterator();
        mux.add(this.acceptConnAndIterateHttpRequests(mux));
        return mux.iterate();
    }
}
/**
 * Parse addr from string
 *
 *     const addr = "::1:8000";
 *     parseAddrFromString(addr);
 *
 * @param addr Address string
 */ export function _parseAddrFromStr(addr) {
    let url;
    try {
        const host = addr.startsWith(":") ? `0.0.0.0${addr}` : addr;
        url = new URL(`http://${host}`);
    } catch  {
        throw new TypeError("Invalid address.");
    }
    if (url.username || url.password || url.pathname != "/" || url.search || url.hash) {
        throw new TypeError("Invalid address.");
    }
    return {
        hostname: url.hostname,
        port: url.port === "" ? 80 : Number(url.port)
    };
}
/**
 * Create a HTTP server
 *
 *     import { serve } from "https://deno.land/std/http/server.ts";
 *     const body = "Hello World\n";
 *     const server = serve({ port: 8000 });
 *     for await (const req of server) {
 *       req.respond({ body });
 *     }
 */ export function serve(addr) {
    if (typeof addr === "string") {
        addr = _parseAddrFromStr(addr);
    }
    const listener = Deno.listen(addr);
    return new Server(listener);
}
/**
 * Start an HTTP server with given options and request handler
 *
 *     const body = "Hello World\n";
 *     const options = { port: 8000 };
 *     listenAndServe(options, (req) => {
 *       req.respond({ body });
 *     });
 *
 * @param options Server configuration
 * @param handler Request handler
 */ export async function listenAndServe(addr, handler) {
    const server = serve(addr);
    for await (const request of server){
        handler(request);
    }
}
/**
 * Create an HTTPS server with given options
 *
 *     const body = "Hello HTTPS";
 *     const options = {
 *       hostname: "localhost",
 *       port: 443,
 *       certFile: "./path/to/localhost.crt",
 *       keyFile: "./path/to/localhost.key",
 *     };
 *     for await (const req of serveTLS(options)) {
 *       req.respond({ body });
 *     }
 *
 * @param options Server configuration
 * @return Async iterable server instance for incoming requests
 */ export function serveTLS(options) {
    const tlsOptions = {
        ...options,
        transport: "tcp"
    };
    const listener = Deno.listenTls(tlsOptions);
    return new Server(listener);
}
/**
 * Start an HTTPS server with given options and request handler
 *
 *     const body = "Hello HTTPS";
 *     const options = {
 *       hostname: "localhost",
 *       port: 443,
 *       certFile: "./path/to/localhost.crt",
 *       keyFile: "./path/to/localhost.key",
 *     };
 *     listenAndServeTLS(options, (req) => {
 *       req.respond({ body });
 *     });
 *
 * @param options Server configuration
 * @param handler Request handler
 */ export async function listenAndServeTLS(options, handler) {
    const server = serveTLS(options);
    for await (const request of server){
        handler(request);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIjxodHRwczovL2Rlbm8ubGFuZC9zdGRAMC44NC4wL2h0dHAvc2VydmVyLnRzPiJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBDb3B5cmlnaHQgMjAxOC0yMDIxIHRoZSBEZW5vIGF1dGhvcnMuIEFsbCByaWdodHMgcmVzZXJ2ZWQuIE1JVCBsaWNlbnNlLlxuaW1wb3J0IHsgZW5jb2RlIH0gZnJvbSBcIi4uL2VuY29kaW5nL3V0ZjgudHNcIjtcbmltcG9ydCB7IEJ1ZlJlYWRlciwgQnVmV3JpdGVyIH0gZnJvbSBcIi4uL2lvL2J1ZmlvLnRzXCI7XG5pbXBvcnQgeyBhc3NlcnQgfSBmcm9tIFwiLi4vX3V0aWwvYXNzZXJ0LnRzXCI7XG5pbXBvcnQgeyBEZWZlcnJlZCwgZGVmZXJyZWQsIE11eEFzeW5jSXRlcmF0b3IgfSBmcm9tIFwiLi4vYXN5bmMvbW9kLnRzXCI7XG5pbXBvcnQge1xuICBib2R5UmVhZGVyLFxuICBjaHVua2VkQm9keVJlYWRlcixcbiAgZW1wdHlSZWFkZXIsXG4gIHJlYWRSZXF1ZXN0LFxuICB3cml0ZVJlc3BvbnNlLFxufSBmcm9tIFwiLi9faW8udHNcIjtcblxuZXhwb3J0IGNsYXNzIFNlcnZlclJlcXVlc3Qge1xuICB1cmwhOiBzdHJpbmc7XG4gIG1ldGhvZCE6IHN0cmluZztcbiAgcHJvdG8hOiBzdHJpbmc7XG4gIHByb3RvTWlub3IhOiBudW1iZXI7XG4gIHByb3RvTWFqb3IhOiBudW1iZXI7XG4gIGhlYWRlcnMhOiBIZWFkZXJzO1xuICBjb25uITogRGVuby5Db25uO1xuICByITogQnVmUmVhZGVyO1xuICB3ITogQnVmV3JpdGVyO1xuXG4gICNkb25lOiBEZWZlcnJlZDxFcnJvciB8IHVuZGVmaW5lZD4gPSBkZWZlcnJlZCgpO1xuICAjY29udGVudExlbmd0aD86IG51bWJlciB8IG51bGwgPSB1bmRlZmluZWQ7XG4gICNib2R5PzogRGVuby5SZWFkZXIgPSB1bmRlZmluZWQ7XG4gICNmaW5hbGl6ZWQgPSBmYWxzZTtcblxuICBnZXQgZG9uZSgpOiBQcm9taXNlPEVycm9yIHwgdW5kZWZpbmVkPiB7XG4gICAgcmV0dXJuIHRoaXMuI2RvbmUudGhlbigoZSkgPT4gZSk7XG4gIH1cblxuICAvKipcbiAgICogVmFsdWUgb2YgQ29udGVudC1MZW5ndGggaGVhZGVyLlxuICAgKiBJZiBudWxsLCB0aGVuIGNvbnRlbnQgbGVuZ3RoIGlzIGludmFsaWQgb3Igbm90IGdpdmVuIChlLmcuIGNodW5rZWQgZW5jb2RpbmcpLlxuICAgKi9cbiAgZ2V0IGNvbnRlbnRMZW5ndGgoKTogbnVtYmVyIHwgbnVsbCB7XG4gICAgLy8gdW5kZWZpbmVkIG1lYW5zIG5vdCBjYWNoZWQuXG4gICAgLy8gbnVsbCBtZWFucyBpbnZhbGlkIG9yIG5vdCBwcm92aWRlZC5cbiAgICBpZiAodGhpcy4jY29udGVudExlbmd0aCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBjbCA9IHRoaXMuaGVhZGVycy5nZXQoXCJjb250ZW50LWxlbmd0aFwiKTtcbiAgICAgIGlmIChjbCkge1xuICAgICAgICB0aGlzLiNjb250ZW50TGVuZ3RoID0gcGFyc2VJbnQoY2wpO1xuICAgICAgICAvLyBDb252ZXJ0IE5hTiB0byBudWxsIChhcyBOYU4gaGFyZGVyIHRvIHRlc3QpXG4gICAgICAgIGlmIChOdW1iZXIuaXNOYU4odGhpcy4jY29udGVudExlbmd0aCkpIHtcbiAgICAgICAgICB0aGlzLiNjb250ZW50TGVuZ3RoID0gbnVsbDtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy4jY29udGVudExlbmd0aCA9IG51bGw7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB0aGlzLiNjb250ZW50TGVuZ3RoO1xuICB9XG5cbiAgLyoqXG4gICAqIEJvZHkgb2YgdGhlIHJlcXVlc3QuICBUaGUgZWFzaWVzdCB3YXkgdG8gY29uc3VtZSB0aGUgYm9keSBpczpcbiAgICpcbiAgICogICAgIGNvbnN0IGJ1ZjogVWludDhBcnJheSA9IGF3YWl0IERlbm8ucmVhZEFsbChyZXEuYm9keSk7XG4gICAqL1xuICBnZXQgYm9keSgpOiBEZW5vLlJlYWRlciB7XG4gICAgaWYgKCF0aGlzLiNib2R5KSB7XG4gICAgICBpZiAodGhpcy5jb250ZW50TGVuZ3RoICE9IG51bGwpIHtcbiAgICAgICAgdGhpcy4jYm9keSA9IGJvZHlSZWFkZXIodGhpcy5jb250ZW50TGVuZ3RoLCB0aGlzLnIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgdHJhbnNmZXJFbmNvZGluZyA9IHRoaXMuaGVhZGVycy5nZXQoXCJ0cmFuc2Zlci1lbmNvZGluZ1wiKTtcbiAgICAgICAgaWYgKHRyYW5zZmVyRW5jb2RpbmcgIT0gbnVsbCkge1xuICAgICAgICAgIGNvbnN0IHBhcnRzID0gdHJhbnNmZXJFbmNvZGluZ1xuICAgICAgICAgICAgLnNwbGl0KFwiLFwiKVxuICAgICAgICAgICAgLm1hcCgoZSk6IHN0cmluZyA9PiBlLnRyaW0oKS50b0xvd2VyQ2FzZSgpKTtcbiAgICAgICAgICBhc3NlcnQoXG4gICAgICAgICAgICBwYXJ0cy5pbmNsdWRlcyhcImNodW5rZWRcIiksXG4gICAgICAgICAgICAndHJhbnNmZXItZW5jb2RpbmcgbXVzdCBpbmNsdWRlIFwiY2h1bmtlZFwiIGlmIGNvbnRlbnQtbGVuZ3RoIGlzIG5vdCBzZXQnLFxuICAgICAgICAgICk7XG4gICAgICAgICAgdGhpcy4jYm9keSA9IGNodW5rZWRCb2R5UmVhZGVyKHRoaXMuaGVhZGVycywgdGhpcy5yKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBOZWl0aGVyIGNvbnRlbnQtbGVuZ3RoIG5vciB0cmFuc2Zlci1lbmNvZGluZzogY2h1bmtlZFxuICAgICAgICAgIHRoaXMuI2JvZHkgPSBlbXB0eVJlYWRlcigpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB0aGlzLiNib2R5O1xuICB9XG5cbiAgYXN5bmMgcmVzcG9uZChyOiBSZXNwb25zZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGxldCBlcnI6IEVycm9yIHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICAvLyBXcml0ZSBvdXIgcmVzcG9uc2UhXG4gICAgICBhd2FpdCB3cml0ZVJlc3BvbnNlKHRoaXMudywgcik7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gRWFnZXJseSBjbG9zZSBvbiBlcnJvci5cbiAgICAgICAgdGhpcy5jb25uLmNsb3NlKCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gUGFzc1xuICAgICAgfVxuICAgICAgZXJyID0gZTtcbiAgICB9XG4gICAgLy8gU2lnbmFsIHRoYXQgdGhpcyByZXF1ZXN0IGhhcyBiZWVuIHByb2Nlc3NlZCBhbmQgdGhlIG5leHQgcGlwZWxpbmVkXG4gICAgLy8gcmVxdWVzdCBvbiB0aGUgc2FtZSBjb25uZWN0aW9uIGNhbiBiZSBhY2NlcHRlZC5cbiAgICB0aGlzLiNkb25lLnJlc29sdmUoZXJyKTtcbiAgICBpZiAoZXJyKSB7XG4gICAgICAvLyBFcnJvciBkdXJpbmcgcmVzcG9uZGluZywgcmV0aHJvdy5cbiAgICAgIHRocm93IGVycjtcbiAgICB9XG4gIH1cblxuICBhc3luYyBmaW5hbGl6ZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy4jZmluYWxpemVkKSByZXR1cm47XG4gICAgLy8gQ29uc3VtZSB1bnJlYWQgYm9keVxuICAgIGNvbnN0IGJvZHkgPSB0aGlzLmJvZHk7XG4gICAgY29uc3QgYnVmID0gbmV3IFVpbnQ4QXJyYXkoMTAyNCk7XG4gICAgd2hpbGUgKChhd2FpdCBib2R5LnJlYWQoYnVmKSkgIT09IG51bGwpIHtcbiAgICAgIC8vIFBhc3NcbiAgICB9XG4gICAgdGhpcy4jZmluYWxpemVkID0gdHJ1ZTtcbiAgfVxufVxuXG5leHBvcnQgY2xhc3MgU2VydmVyIGltcGxlbWVudHMgQXN5bmNJdGVyYWJsZTxTZXJ2ZXJSZXF1ZXN0PiB7XG4gICNjbG9zaW5nID0gZmFsc2U7XG4gICNjb25uZWN0aW9uczogRGVuby5Db25uW10gPSBbXTtcblxuICBjb25zdHJ1Y3RvcihwdWJsaWMgbGlzdGVuZXI6IERlbm8uTGlzdGVuZXIpIHt9XG5cbiAgY2xvc2UoKTogdm9pZCB7XG4gICAgdGhpcy4jY2xvc2luZyA9IHRydWU7XG4gICAgdGhpcy5saXN0ZW5lci5jbG9zZSgpO1xuICAgIGZvciAoY29uc3QgY29ubiBvZiB0aGlzLiNjb25uZWN0aW9ucykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29ubi5jbG9zZSgpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAvLyBDb25uZWN0aW9uIG1pZ2h0IGhhdmUgYmVlbiBhbHJlYWR5IGNsb3NlZFxuICAgICAgICBpZiAoIShlIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuQmFkUmVzb3VyY2UpKSB7XG4gICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIFlpZWxkcyBhbGwgSFRUUCByZXF1ZXN0cyBvbiBhIHNpbmdsZSBUQ1AgY29ubmVjdGlvbi5cbiAgcHJpdmF0ZSBhc3luYyAqaXRlcmF0ZUh0dHBSZXF1ZXN0cyhcbiAgICBjb25uOiBEZW5vLkNvbm4sXG4gICk6IEFzeW5jSXRlcmFibGVJdGVyYXRvcjxTZXJ2ZXJSZXF1ZXN0PiB7XG4gICAgY29uc3QgcmVhZGVyID0gbmV3IEJ1ZlJlYWRlcihjb25uKTtcbiAgICBjb25zdCB3cml0ZXIgPSBuZXcgQnVmV3JpdGVyKGNvbm4pO1xuXG4gICAgd2hpbGUgKCF0aGlzLiNjbG9zaW5nKSB7XG4gICAgICBsZXQgcmVxdWVzdDogU2VydmVyUmVxdWVzdCB8IG51bGw7XG4gICAgICB0cnkge1xuICAgICAgICByZXF1ZXN0ID0gYXdhaXQgcmVhZFJlcXVlc3QoY29ubiwgcmVhZGVyKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLkludmFsaWREYXRhIHx8XG4gICAgICAgICAgZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5VbmV4cGVjdGVkRW9mXG4gICAgICAgICkge1xuICAgICAgICAgIC8vIEFuIGVycm9yIHdhcyB0aHJvd24gd2hpbGUgcGFyc2luZyByZXF1ZXN0IGhlYWRlcnMuXG4gICAgICAgICAgLy8gVHJ5IHRvIHNlbmQgdGhlIFwiNDAwIEJhZCBSZXF1ZXN0XCIgYmVmb3JlIGNsb3NpbmcgdGhlIGNvbm5lY3Rpb24uXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IHdyaXRlUmVzcG9uc2Uod3JpdGVyLCB7XG4gICAgICAgICAgICAgIHN0YXR1czogNDAwLFxuICAgICAgICAgICAgICBib2R5OiBlbmNvZGUoYCR7ZXJyb3IubWVzc2FnZX1cXHJcXG5cXHJcXG5gKSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAvLyBUaGUgY29ubmVjdGlvbiBpcyBicm9rZW4uXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgaWYgKHJlcXVlc3QgPT09IG51bGwpIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIHJlcXVlc3QudyA9IHdyaXRlcjtcbiAgICAgIHlpZWxkIHJlcXVlc3Q7XG5cbiAgICAgIC8vIFdhaXQgZm9yIHRoZSByZXF1ZXN0IHRvIGJlIHByb2Nlc3NlZCBiZWZvcmUgd2UgYWNjZXB0IGEgbmV3IHJlcXVlc3Qgb25cbiAgICAgIC8vIHRoaXMgY29ubmVjdGlvbi5cbiAgICAgIGNvbnN0IHJlc3BvbnNlRXJyb3IgPSBhd2FpdCByZXF1ZXN0LmRvbmU7XG4gICAgICBpZiAocmVzcG9uc2VFcnJvcikge1xuICAgICAgICAvLyBTb21ldGhpbmcgYmFkIGhhcHBlbmVkIGR1cmluZyByZXNwb25zZS5cbiAgICAgICAgLy8gKGxpa2VseSBvdGhlciBzaWRlIGNsb3NlZCBkdXJpbmcgcGlwZWxpbmVkIHJlcSlcbiAgICAgICAgLy8gcmVxLmRvbmUgaW1wbGllcyB0aGlzIGNvbm5lY3Rpb24gYWxyZWFkeSBjbG9zZWQsIHNvIHdlIGNhbiBqdXN0IHJldHVybi5cbiAgICAgICAgdGhpcy51bnRyYWNrQ29ubmVjdGlvbihyZXF1ZXN0LmNvbm4pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIC8vIENvbnN1bWUgdW5yZWFkIGJvZHkgYW5kIHRyYWlsZXJzIGlmIHJlY2VpdmVyIGRpZG4ndCBjb25zdW1lIHRob3NlIGRhdGFcbiAgICAgICAgYXdhaXQgcmVxdWVzdC5maW5hbGl6ZSgpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgLy8gSW52YWxpZCBkYXRhIHdhcyByZWNlaXZlZCBvciB0aGUgY29ubmVjdGlvbiB3YXMgY2xvc2VkLlxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICB0aGlzLnVudHJhY2tDb25uZWN0aW9uKGNvbm4pO1xuICAgIHRyeSB7XG4gICAgICBjb25uLmNsb3NlKCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgLy8gbWlnaHQgaGF2ZSBiZWVuIGFscmVhZHkgY2xvc2VkXG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSB0cmFja0Nvbm5lY3Rpb24oY29ubjogRGVuby5Db25uKTogdm9pZCB7XG4gICAgdGhpcy4jY29ubmVjdGlvbnMucHVzaChjb25uKTtcbiAgfVxuXG4gIHByaXZhdGUgdW50cmFja0Nvbm5lY3Rpb24oY29ubjogRGVuby5Db25uKTogdm9pZCB7XG4gICAgY29uc3QgaW5kZXggPSB0aGlzLiNjb25uZWN0aW9ucy5pbmRleE9mKGNvbm4pO1xuICAgIGlmIChpbmRleCAhPT0gLTEpIHtcbiAgICAgIHRoaXMuI2Nvbm5lY3Rpb25zLnNwbGljZShpbmRleCwgMSk7XG4gICAgfVxuICB9XG5cbiAgLy8gQWNjZXB0cyBhIG5ldyBUQ1AgY29ubmVjdGlvbiBhbmQgeWllbGRzIGFsbCBIVFRQIHJlcXVlc3RzIHRoYXQgYXJyaXZlIG9uXG4gIC8vIGl0LiBXaGVuIGEgY29ubmVjdGlvbiBpcyBhY2NlcHRlZCwgaXQgYWxzbyBjcmVhdGVzIGEgbmV3IGl0ZXJhdG9yIG9mIHRoZVxuICAvLyBzYW1lIGtpbmQgYW5kIGFkZHMgaXQgdG8gdGhlIHJlcXVlc3QgbXVsdGlwbGV4ZXIgc28gdGhhdCBhbm90aGVyIFRDUFxuICAvLyBjb25uZWN0aW9uIGNhbiBiZSBhY2NlcHRlZC5cbiAgcHJpdmF0ZSBhc3luYyAqYWNjZXB0Q29ubkFuZEl0ZXJhdGVIdHRwUmVxdWVzdHMoXG4gICAgbXV4OiBNdXhBc3luY0l0ZXJhdG9yPFNlcnZlclJlcXVlc3Q+LFxuICApOiBBc3luY0l0ZXJhYmxlSXRlcmF0b3I8U2VydmVyUmVxdWVzdD4ge1xuICAgIGlmICh0aGlzLiNjbG9zaW5nKSByZXR1cm47XG4gICAgLy8gV2FpdCBmb3IgYSBuZXcgY29ubmVjdGlvbi5cbiAgICBsZXQgY29ubjogRGVuby5Db25uO1xuICAgIHRyeSB7XG4gICAgICBjb25uID0gYXdhaXQgdGhpcy5saXN0ZW5lci5hY2NlcHQoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKFxuICAgICAgICAvLyBUaGUgbGlzdGVuZXIgaXMgY2xvc2VkOlxuICAgICAgICBlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLkJhZFJlc291cmNlIHx8XG4gICAgICAgIC8vIFRMUyBoYW5kc2hha2UgZXJyb3JzOlxuICAgICAgICBlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLkludmFsaWREYXRhIHx8XG4gICAgICAgIGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuVW5leHBlY3RlZEVvZiB8fFxuICAgICAgICBlcnJvciBpbnN0YW5jZW9mIERlbm8uZXJyb3JzLkNvbm5lY3Rpb25SZXNldFxuICAgICAgKSB7XG4gICAgICAgIHJldHVybiBtdXguYWRkKHRoaXMuYWNjZXB0Q29ubkFuZEl0ZXJhdGVIdHRwUmVxdWVzdHMobXV4KSk7XG4gICAgICB9XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9XG4gICAgdGhpcy50cmFja0Nvbm5lY3Rpb24oY29ubik7XG4gICAgLy8gVHJ5IHRvIGFjY2VwdCBhbm90aGVyIGNvbm5lY3Rpb24gYW5kIGFkZCBpdCB0byB0aGUgbXVsdGlwbGV4ZXIuXG4gICAgbXV4LmFkZCh0aGlzLmFjY2VwdENvbm5BbmRJdGVyYXRlSHR0cFJlcXVlc3RzKG11eCkpO1xuICAgIC8vIFlpZWxkIHRoZSByZXF1ZXN0cyB0aGF0IGFycml2ZSBvbiB0aGUganVzdC1hY2NlcHRlZCBjb25uZWN0aW9uLlxuICAgIHlpZWxkKiB0aGlzLml0ZXJhdGVIdHRwUmVxdWVzdHMoY29ubik7XG4gIH1cblxuICBbU3ltYm9sLmFzeW5jSXRlcmF0b3JdKCk6IEFzeW5jSXRlcmFibGVJdGVyYXRvcjxTZXJ2ZXJSZXF1ZXN0PiB7XG4gICAgY29uc3QgbXV4OiBNdXhBc3luY0l0ZXJhdG9yPFNlcnZlclJlcXVlc3Q+ID0gbmV3IE11eEFzeW5jSXRlcmF0b3IoKTtcbiAgICBtdXguYWRkKHRoaXMuYWNjZXB0Q29ubkFuZEl0ZXJhdGVIdHRwUmVxdWVzdHMobXV4KSk7XG4gICAgcmV0dXJuIG11eC5pdGVyYXRlKCk7XG4gIH1cbn1cblxuLyoqIE9wdGlvbnMgZm9yIGNyZWF0aW5nIGFuIEhUVFAgc2VydmVyLiAqL1xuZXhwb3J0IHR5cGUgSFRUUE9wdGlvbnMgPSBPbWl0PERlbm8uTGlzdGVuT3B0aW9ucywgXCJ0cmFuc3BvcnRcIj47XG5cbi8qKlxuICogUGFyc2UgYWRkciBmcm9tIHN0cmluZ1xuICpcbiAqICAgICBjb25zdCBhZGRyID0gXCI6OjE6ODAwMFwiO1xuICogICAgIHBhcnNlQWRkckZyb21TdHJpbmcoYWRkcik7XG4gKlxuICogQHBhcmFtIGFkZHIgQWRkcmVzcyBzdHJpbmdcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIF9wYXJzZUFkZHJGcm9tU3RyKGFkZHI6IHN0cmluZyk6IEhUVFBPcHRpb25zIHtcbiAgbGV0IHVybDogVVJMO1xuICB0cnkge1xuICAgIGNvbnN0IGhvc3QgPSBhZGRyLnN0YXJ0c1dpdGgoXCI6XCIpID8gYDAuMC4wLjAke2FkZHJ9YCA6IGFkZHI7XG4gICAgdXJsID0gbmV3IFVSTChgaHR0cDovLyR7aG9zdH1gKTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcIkludmFsaWQgYWRkcmVzcy5cIik7XG4gIH1cbiAgaWYgKFxuICAgIHVybC51c2VybmFtZSB8fFxuICAgIHVybC5wYXNzd29yZCB8fFxuICAgIHVybC5wYXRobmFtZSAhPSBcIi9cIiB8fFxuICAgIHVybC5zZWFyY2ggfHxcbiAgICB1cmwuaGFzaFxuICApIHtcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFwiSW52YWxpZCBhZGRyZXNzLlwiKTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgaG9zdG5hbWU6IHVybC5ob3N0bmFtZSxcbiAgICBwb3J0OiB1cmwucG9ydCA9PT0gXCJcIiA/IDgwIDogTnVtYmVyKHVybC5wb3J0KSxcbiAgfTtcbn1cblxuLyoqXG4gKiBDcmVhdGUgYSBIVFRQIHNlcnZlclxuICpcbiAqICAgICBpbXBvcnQgeyBzZXJ2ZSB9IGZyb20gXCJodHRwczovL2Rlbm8ubGFuZC9zdGQvaHR0cC9zZXJ2ZXIudHNcIjtcbiAqICAgICBjb25zdCBib2R5ID0gXCJIZWxsbyBXb3JsZFxcblwiO1xuICogICAgIGNvbnN0IHNlcnZlciA9IHNlcnZlKHsgcG9ydDogODAwMCB9KTtcbiAqICAgICBmb3IgYXdhaXQgKGNvbnN0IHJlcSBvZiBzZXJ2ZXIpIHtcbiAqICAgICAgIHJlcS5yZXNwb25kKHsgYm9keSB9KTtcbiAqICAgICB9XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXJ2ZShhZGRyOiBzdHJpbmcgfCBIVFRQT3B0aW9ucyk6IFNlcnZlciB7XG4gIGlmICh0eXBlb2YgYWRkciA9PT0gXCJzdHJpbmdcIikge1xuICAgIGFkZHIgPSBfcGFyc2VBZGRyRnJvbVN0cihhZGRyKTtcbiAgfVxuXG4gIGNvbnN0IGxpc3RlbmVyID0gRGVuby5saXN0ZW4oYWRkcik7XG4gIHJldHVybiBuZXcgU2VydmVyKGxpc3RlbmVyKTtcbn1cblxuLyoqXG4gKiBTdGFydCBhbiBIVFRQIHNlcnZlciB3aXRoIGdpdmVuIG9wdGlvbnMgYW5kIHJlcXVlc3QgaGFuZGxlclxuICpcbiAqICAgICBjb25zdCBib2R5ID0gXCJIZWxsbyBXb3JsZFxcblwiO1xuICogICAgIGNvbnN0IG9wdGlvbnMgPSB7IHBvcnQ6IDgwMDAgfTtcbiAqICAgICBsaXN0ZW5BbmRTZXJ2ZShvcHRpb25zLCAocmVxKSA9PiB7XG4gKiAgICAgICByZXEucmVzcG9uZCh7IGJvZHkgfSk7XG4gKiAgICAgfSk7XG4gKlxuICogQHBhcmFtIG9wdGlvbnMgU2VydmVyIGNvbmZpZ3VyYXRpb25cbiAqIEBwYXJhbSBoYW5kbGVyIFJlcXVlc3QgaGFuZGxlclxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbGlzdGVuQW5kU2VydmUoXG4gIGFkZHI6IHN0cmluZyB8IEhUVFBPcHRpb25zLFxuICBoYW5kbGVyOiAocmVxOiBTZXJ2ZXJSZXF1ZXN0KSA9PiB2b2lkLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNlcnZlciA9IHNlcnZlKGFkZHIpO1xuXG4gIGZvciBhd2FpdCAoY29uc3QgcmVxdWVzdCBvZiBzZXJ2ZXIpIHtcbiAgICBoYW5kbGVyKHJlcXVlc3QpO1xuICB9XG59XG5cbi8qKiBPcHRpb25zIGZvciBjcmVhdGluZyBhbiBIVFRQUyBzZXJ2ZXIuICovXG5leHBvcnQgdHlwZSBIVFRQU09wdGlvbnMgPSBPbWl0PERlbm8uTGlzdGVuVGxzT3B0aW9ucywgXCJ0cmFuc3BvcnRcIj47XG5cbi8qKlxuICogQ3JlYXRlIGFuIEhUVFBTIHNlcnZlciB3aXRoIGdpdmVuIG9wdGlvbnNcbiAqXG4gKiAgICAgY29uc3QgYm9keSA9IFwiSGVsbG8gSFRUUFNcIjtcbiAqICAgICBjb25zdCBvcHRpb25zID0ge1xuICogICAgICAgaG9zdG5hbWU6IFwibG9jYWxob3N0XCIsXG4gKiAgICAgICBwb3J0OiA0NDMsXG4gKiAgICAgICBjZXJ0RmlsZTogXCIuL3BhdGgvdG8vbG9jYWxob3N0LmNydFwiLFxuICogICAgICAga2V5RmlsZTogXCIuL3BhdGgvdG8vbG9jYWxob3N0LmtleVwiLFxuICogICAgIH07XG4gKiAgICAgZm9yIGF3YWl0IChjb25zdCByZXEgb2Ygc2VydmVUTFMob3B0aW9ucykpIHtcbiAqICAgICAgIHJlcS5yZXNwb25kKHsgYm9keSB9KTtcbiAqICAgICB9XG4gKlxuICogQHBhcmFtIG9wdGlvbnMgU2VydmVyIGNvbmZpZ3VyYXRpb25cbiAqIEByZXR1cm4gQXN5bmMgaXRlcmFibGUgc2VydmVyIGluc3RhbmNlIGZvciBpbmNvbWluZyByZXF1ZXN0c1xuICovXG5leHBvcnQgZnVuY3Rpb24gc2VydmVUTFMob3B0aW9uczogSFRUUFNPcHRpb25zKTogU2VydmVyIHtcbiAgY29uc3QgdGxzT3B0aW9uczogRGVuby5MaXN0ZW5UbHNPcHRpb25zID0ge1xuICAgIC4uLm9wdGlvbnMsXG4gICAgdHJhbnNwb3J0OiBcInRjcFwiLFxuICB9O1xuICBjb25zdCBsaXN0ZW5lciA9IERlbm8ubGlzdGVuVGxzKHRsc09wdGlvbnMpO1xuICByZXR1cm4gbmV3IFNlcnZlcihsaXN0ZW5lcik7XG59XG5cbi8qKlxuICogU3RhcnQgYW4gSFRUUFMgc2VydmVyIHdpdGggZ2l2ZW4gb3B0aW9ucyBhbmQgcmVxdWVzdCBoYW5kbGVyXG4gKlxuICogICAgIGNvbnN0IGJvZHkgPSBcIkhlbGxvIEhUVFBTXCI7XG4gKiAgICAgY29uc3Qgb3B0aW9ucyA9IHtcbiAqICAgICAgIGhvc3RuYW1lOiBcImxvY2FsaG9zdFwiLFxuICogICAgICAgcG9ydDogNDQzLFxuICogICAgICAgY2VydEZpbGU6IFwiLi9wYXRoL3RvL2xvY2FsaG9zdC5jcnRcIixcbiAqICAgICAgIGtleUZpbGU6IFwiLi9wYXRoL3RvL2xvY2FsaG9zdC5rZXlcIixcbiAqICAgICB9O1xuICogICAgIGxpc3RlbkFuZFNlcnZlVExTKG9wdGlvbnMsIChyZXEpID0+IHtcbiAqICAgICAgIHJlcS5yZXNwb25kKHsgYm9keSB9KTtcbiAqICAgICB9KTtcbiAqXG4gKiBAcGFyYW0gb3B0aW9ucyBTZXJ2ZXIgY29uZmlndXJhdGlvblxuICogQHBhcmFtIGhhbmRsZXIgUmVxdWVzdCBoYW5kbGVyXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsaXN0ZW5BbmRTZXJ2ZVRMUyhcbiAgb3B0aW9uczogSFRUUFNPcHRpb25zLFxuICBoYW5kbGVyOiAocmVxOiBTZXJ2ZXJSZXF1ZXN0KSA9PiB2b2lkLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNlcnZlciA9IHNlcnZlVExTKG9wdGlvbnMpO1xuXG4gIGZvciBhd2FpdCAoY29uc3QgcmVxdWVzdCBvZiBzZXJ2ZXIpIHtcbiAgICBoYW5kbGVyKHJlcXVlc3QpO1xuICB9XG59XG5cbi8qKlxuICogSW50ZXJmYWNlIG9mIEhUVFAgc2VydmVyIHJlc3BvbnNlLlxuICogSWYgYm9keSBpcyBhIFJlYWRlciwgcmVzcG9uc2Ugd291bGQgYmUgY2h1bmtlZC5cbiAqIElmIGJvZHkgaXMgYSBzdHJpbmcsIGl0IHdvdWxkIGJlIFVURi04IGVuY29kZWQgYnkgZGVmYXVsdC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBSZXNwb25zZSB7XG4gIHN0YXR1cz86IG51bWJlcjtcbiAgaGVhZGVycz86IEhlYWRlcnM7XG4gIGJvZHk/OiBVaW50OEFycmF5IHwgRGVuby5SZWFkZXIgfCBzdHJpbmc7XG4gIHRyYWlsZXJzPzogKCkgPT4gUHJvbWlzZTxIZWFkZXJzPiB8IEhlYWRlcnM7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsRUFBQSx3RUFBQTtTQUNBLE1BQUEsU0FBQSxtQkFBQTtTQUNBLFNBQUEsRUFBQSxTQUFBLFNBQUEsY0FBQTtTQUNBLE1BQUEsU0FBQSxrQkFBQTtTQUNBLFFBQUEsRUFBQSxnQkFBQSxTQUFBLGVBQUE7U0FFQSxVQUFBLEVBQ0EsaUJBQUEsRUFDQSxXQUFBLEVB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QUEsQ0FBQSxXQUFBLElBQ0EsS0FBQSxZQUFBLElBQUEsQ0FBQSxNQUFBLENBQUEsYUFBQSxJQUNBLEtBQUEsWUFBQSxJQUFBLENBQUEsTUFBQSxDQUFBLGVBQUE7dUJBRUEsR0FBQSxDQUFBLEdBQUEsTUFBQSxnQ0FBQSxDQUFBLEdBQUE7O2tCQUVBLEtBQUE7O2FBRUEsZUFBQSxDQUFBLElBQUE7QUFDQSxVQUFBLGdFQUFBO0FBQ0EsV0FBQSxDQUFBLEdBQUEsTUFBQSxnQ0FBQSxDQUFBLEdBQUE7QUFDQSxVQUFBLGdFQUFBO29CQUNBLG1CQUFBLENBQUEsSUFBQTs7S0FHQSxNQUFBLENBQUEsYUFBQTtjQUNBLEdBQUEsT0FBQSxnQkFBQTtBQUNBLFdBQUEsQ0FBQSxHQUFBLE1BQUEsZ0NBQUEsQ0FBQSxHQUFBO2VBQ0EsR0FBQSxDQUFBLE9BQUE7OztBQU9BLEVBT0EsQUFQQSxtSUFPQSxBQVBBLEVBT0EsaUJBQ0EsaUJBQUEsQ0FBQSxJQUFBO1FBQ0EsR0FBQTs7Y0FFQSxJQUFBLEdBQUEsSUFBQSxDQUFBLFVBQUEsRUFBQSxDQUFBLE1BQUEsT0FBQSxFQUFBLElBQUEsS0FBQSxJQUFBO0FBQ0EsV0FBQSxPQUFBLEdBQUEsRUFBQSxPQUFBLEVBQUEsSUFBQTs7a0JBRUEsU0FBQSxFQUFBLGdCQUFBOztRQUdBLEdBQUEsQ0FBQSxRQUFBLElBQ0EsR0FBQSxDQUFBLFFBQUEsSUFDQSxHQUFBLENBQUEsUUFBQSxLQUFBLENBQUEsS0FDQSxHQUFBLENBQUEsTUFBQSxJQUNBLEdBQUEsQ0FBQSxJQUFBO2tCQUVBLFNBQUEsRUFBQSxnQkFBQTs7O0FBSUEsZ0JBQUEsRUFBQSxHQUFBLENBQUEsUUFBQTtBQUNBLFlBQUEsRUFBQSxHQUFBLENBQUEsSUFBQSxVQUFBLEVBQUEsR0FBQSxNQUFBLENBQUEsR0FBQSxDQUFBLElBQUE7OztBQUlBLEVBU0EsQUFUQSx1UUFTQSxBQVRBLEVBU0EsaUJBQ0EsS0FBQSxDQUFBLElBQUE7ZUFDQSxJQUFBLE1BQUEsTUFBQTtBQUNBLFlBQUEsR0FBQSxpQkFBQSxDQUFBLElBQUE7O1VBR0EsUUFBQSxHQUFBLElBQUEsQ0FBQSxNQUFBLENBQUEsSUFBQTtlQUNBLE1BQUEsQ0FBQSxRQUFBOztBQUdBLEVBV0EsQUFYQSxrVEFXQSxBQVhBLEVBV0EsdUJBQ0EsY0FBQSxDQUNBLElBQUEsRUFDQSxPQUFBO1VBRUEsTUFBQSxHQUFBLEtBQUEsQ0FBQSxJQUFBO3FCQUVBLE9BQUEsSUFBQSxNQUFBO0FBQ0EsZUFBQSxDQUFBLE9BQUE7OztBQU9BLEVBZ0JBLEFBaEJBLCtjQWdCQSxBQWhCQSxFQWdCQSxpQkFDQSxRQUFBLENBQUEsT0FBQTtVQUNBLFVBQUE7V0FDQSxPQUFBO0FBQ0EsaUJBQUEsR0FBQSxHQUFBOztVQUVBLFFBQUEsR0FBQSxJQUFBLENBQUEsU0FBQSxDQUFBLFVBQUE7ZUFDQSxNQUFBLENBQUEsUUFBQTs7QUFHQSxFQWdCQSxBQWhCQSwrYkFnQkEsQUFoQkEsRUFnQkEsdUJBQ0EsaUJBQUEsQ0FDQSxPQUFBLEVBQ0EsT0FBQTtVQUVBLE1BQUEsR0FBQSxRQUFBLENBQUEsT0FBQTtxQkFFQSxPQUFBLElBQUEsTUFBQTtBQUNBLGVBQUEsQ0FBQSxPQUFBIn0=