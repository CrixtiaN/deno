// Copyright 2018-2021 the Deno authors. All rights reserved. MIT license.
/** Find first index of binary pattern from source. If not found, then return -1
 * @param source source array
 * @param pat pattern to find in source array
 * @param start the index to start looking in the source
 */ export function indexOf(source, pat, start = 0) {
    if (start >= source.length) {
        return -1;
    }
    if (start < 0) {
        start = 0;
    }
    const s = pat[0];
    for(let i = start; i < source.length; i++){
        if (source[i] !== s) continue;
        const pin = i;
        let matched = 1;
        let j = i;
        while(matched < pat.length){
            j++;
            if (source[j] !== pat[j - pin]) {
                break;
            }
            matched++;
        }
        if (matched === pat.length) {
            return pin;
        }
    }
    return -1;
}
/** Find last index of binary pattern from source. If not found, then return -1.
 * @param source source array
 * @param pat pattern to find in source array
 * @param start the index to start looking in the source
 */ export function lastIndexOf(source, pat, start = source.length - 1) {
    if (start < 0) {
        return -1;
    }
    if (start >= source.length) {
        start = source.length - 1;
    }
    const e = pat[pat.length - 1];
    for(let i = start; i >= 0; i--){
        if (source[i] !== e) continue;
        const pin = i;
        let matched = 1;
        let j = i;
        while(matched < pat.length){
            j--;
            if (source[j] !== pat[pat.length - 1 - (pin - j)]) {
                break;
            }
            matched++;
        }
        if (matched === pat.length) {
            return pin - pat.length + 1;
        }
    }
    return -1;
}
/** Check whether binary arrays are equal to each other.
 * @param a first array to check equality
 * @param b second array to check equality
 */ export function equals(a, b) {
    if (a.length !== b.length) return false;
    for(let i = 0; i < b.length; i++){
        if (a[i] !== b[i]) return false;
    }
    return true;
}
/** Check whether binary array starts with prefix.
 * @param source source array
 * @param prefix prefix array to check in source
 */ export function startsWith(source, prefix) {
    for(let i = 0, max = prefix.length; i < max; i++){
        if (source[i] !== prefix[i]) return false;
    }
    return true;
}
/** Check whether binary array ends with suffix.
 * @param source source array
 * @param suffix suffix array to check in source
 */ export function endsWith(source, suffix) {
    for(let srci = source.length - 1, sfxi = suffix.length - 1; sfxi >= 0; srci--, sfxi--){
        if (source[srci] !== suffix[sfxi]) return false;
    }
    return true;
}
/** Repeat bytes. returns a new byte slice consisting of `count` copies of `b`.
 * @param origin The origin bytes
 * @param count The count you want to repeat.
 * @throws `RangeError` When count is negative
 */ export function repeat(origin, count) {
    if (count === 0) {
        return new Uint8Array();
    }
    if (count < 0) {
        throw new RangeError("bytes: negative repeat count");
    } else if (origin.length * count / count !== origin.length) {
        throw new Error("bytes: repeat count causes overflow");
    }
    const int = Math.floor(count);
    if (int !== count) {
        throw new Error("bytes: repeat count must be an integer");
    }
    const nb = new Uint8Array(origin.length * count);
    let bp = copy(origin, nb);
    for(; bp < nb.length; bp *= 2){
        copy(nb.slice(0, bp), nb, bp);
    }
    return nb;
}
/** Concatenate multiple binary arrays and return new one.
 * @param buf binary arrays to concatenate
 */ export function concat(...buf) {
    let length = 0;
    for (const b of buf){
        length += b.length;
    }
    const output = new Uint8Array(length);
    let index = 0;
    for (const b of buf){
        output.set(b, index);
        index += b.length;
    }
    return output;
}
/** Check source array contains pattern array.
 * @param source source array
 * @param pat patter array
 */ export function contains(source, pat) {
    return indexOf(source, pat) != -1;
}
/**
 * Copy bytes from one Uint8Array to another.  Bytes from `src` which don't fit
 * into `dst` will not be copied.
 *
 * @param src Source byte array
 * @param dst Destination byte array
 * @param off Offset into `dst` at which to begin writing values from `src`.
 * @return number of bytes copied
 */ export function copy(src, dst, off = 0) {
    off = Math.max(0, Math.min(off, dst.byteLength));
    const dstBytesAvailable = dst.byteLength - off;
    if (src.byteLength > dstBytesAvailable) {
        src = src.subarray(0, dstBytesAvailable);
    }
    dst.set(src, off);
    return src.byteLength;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIjxodHRwczovL2Rlbm8ubGFuZC9zdGRAMC44NC4wL2J5dGVzL21vZC50cz4iXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQ29weXJpZ2h0IDIwMTgtMjAyMSB0aGUgRGVubyBhdXRob3JzLiBBbGwgcmlnaHRzIHJlc2VydmVkLiBNSVQgbGljZW5zZS5cblxuLyoqIEZpbmQgZmlyc3QgaW5kZXggb2YgYmluYXJ5IHBhdHRlcm4gZnJvbSBzb3VyY2UuIElmIG5vdCBmb3VuZCwgdGhlbiByZXR1cm4gLTFcbiAqIEBwYXJhbSBzb3VyY2Ugc291cmNlIGFycmF5XG4gKiBAcGFyYW0gcGF0IHBhdHRlcm4gdG8gZmluZCBpbiBzb3VyY2UgYXJyYXlcbiAqIEBwYXJhbSBzdGFydCB0aGUgaW5kZXggdG8gc3RhcnQgbG9va2luZyBpbiB0aGUgc291cmNlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpbmRleE9mKFxuICBzb3VyY2U6IFVpbnQ4QXJyYXksXG4gIHBhdDogVWludDhBcnJheSxcbiAgc3RhcnQgPSAwLFxuKTogbnVtYmVyIHtcbiAgaWYgKHN0YXJ0ID49IHNvdXJjZS5sZW5ndGgpIHtcbiAgICByZXR1cm4gLTE7XG4gIH1cbiAgaWYgKHN0YXJ0IDwgMCkge1xuICAgIHN0YXJ0ID0gMDtcbiAgfVxuICBjb25zdCBzID0gcGF0WzBdO1xuICBmb3IgKGxldCBpID0gc3RhcnQ7IGkgPCBzb3VyY2UubGVuZ3RoOyBpKyspIHtcbiAgICBpZiAoc291cmNlW2ldICE9PSBzKSBjb250aW51ZTtcbiAgICBjb25zdCBwaW4gPSBpO1xuICAgIGxldCBtYXRjaGVkID0gMTtcbiAgICBsZXQgaiA9IGk7XG4gICAgd2hpbGUgKG1hdGNoZWQgPCBwYXQubGVuZ3RoKSB7XG4gICAgICBqKys7XG4gICAgICBpZiAoc291cmNlW2pdICE9PSBwYXRbaiAtIHBpbl0pIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBtYXRjaGVkKys7XG4gICAgfVxuICAgIGlmIChtYXRjaGVkID09PSBwYXQubGVuZ3RoKSB7XG4gICAgICByZXR1cm4gcGluO1xuICAgIH1cbiAgfVxuICByZXR1cm4gLTE7XG59XG5cbi8qKiBGaW5kIGxhc3QgaW5kZXggb2YgYmluYXJ5IHBhdHRlcm4gZnJvbSBzb3VyY2UuIElmIG5vdCBmb3VuZCwgdGhlbiByZXR1cm4gLTEuXG4gKiBAcGFyYW0gc291cmNlIHNvdXJjZSBhcnJheVxuICogQHBhcmFtIHBhdCBwYXR0ZXJuIHRvIGZpbmQgaW4gc291cmNlIGFycmF5XG4gKiBAcGFyYW0gc3RhcnQgdGhlIGluZGV4IHRvIHN0YXJ0IGxvb2tpbmcgaW4gdGhlIHNvdXJjZVxuICovXG5leHBvcnQgZnVuY3Rpb24gbGFzdEluZGV4T2YoXG4gIHNvdXJjZTogVWludDhBcnJheSxcbiAgcGF0OiBVaW50OEFycmF5LFxuICBzdGFydCA9IHNvdXJjZS5sZW5ndGggLSAxLFxuKTogbnVtYmVyIHtcbiAgaWYgKHN0YXJ0IDwgMCkge1xuICAgIHJldHVybiAtMTtcbiAgfVxuICBpZiAoc3RhcnQgPj0gc291cmNlLmxlbmd0aCkge1xuICAgIHN0YXJ0ID0gc291cmNlLmxlbmd0aCAtIDE7XG4gIH1cbiAgY29uc3QgZSA9IHBhdFtwYXQubGVuZ3RoIC0gMV07XG4gIGZvciAobGV0IGkgPSBzdGFydDsgaSA+PSAwOyBpLS0pIHtcbiAgICBpZiAoc291cmNlW2ldICE9PSBlKSBjb250aW51ZTtcbiAgICBjb25zdCBwaW4gPSBpO1xuICAgIGxldCBtYXRjaGVkID0gMTtcbiAgICBsZXQgaiA9IGk7XG4gICAgd2hpbGUgKG1hdGNoZWQgPCBwYXQubGVuZ3RoKSB7XG4gICAgICBqLS07XG4gICAgICBpZiAoc291cmNlW2pdICE9PSBwYXRbcGF0Lmxlbmd0aCAtIDEgLSAocGluIC0gaildKSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgbWF0Y2hlZCsrO1xuICAgIH1cbiAgICBpZiAobWF0Y2hlZCA9PT0gcGF0Lmxlbmd0aCkge1xuICAgICAgcmV0dXJuIHBpbiAtIHBhdC5sZW5ndGggKyAxO1xuICAgIH1cbiAgfVxuICByZXR1cm4gLTE7XG59XG5cbi8qKiBDaGVjayB3aGV0aGVyIGJpbmFyeSBhcnJheXMgYXJlIGVxdWFsIHRvIGVhY2ggb3RoZXIuXG4gKiBAcGFyYW0gYSBmaXJzdCBhcnJheSB0byBjaGVjayBlcXVhbGl0eVxuICogQHBhcmFtIGIgc2Vjb25kIGFycmF5IHRvIGNoZWNrIGVxdWFsaXR5XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlcXVhbHMoYTogVWludDhBcnJheSwgYjogVWludDhBcnJheSk6IGJvb2xlYW4ge1xuICBpZiAoYS5sZW5ndGggIT09IGIubGVuZ3RoKSByZXR1cm4gZmFsc2U7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYi5sZW5ndGg7IGkrKykge1xuICAgIGlmIChhW2ldICE9PSBiW2ldKSByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKiBDaGVjayB3aGV0aGVyIGJpbmFyeSBhcnJheSBzdGFydHMgd2l0aCBwcmVmaXguXG4gKiBAcGFyYW0gc291cmNlIHNvdXJjZSBhcnJheVxuICogQHBhcmFtIHByZWZpeCBwcmVmaXggYXJyYXkgdG8gY2hlY2sgaW4gc291cmNlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydHNXaXRoKHNvdXJjZTogVWludDhBcnJheSwgcHJlZml4OiBVaW50OEFycmF5KTogYm9vbGVhbiB7XG4gIGZvciAobGV0IGkgPSAwLCBtYXggPSBwcmVmaXgubGVuZ3RoOyBpIDwgbWF4OyBpKyspIHtcbiAgICBpZiAoc291cmNlW2ldICE9PSBwcmVmaXhbaV0pIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqIENoZWNrIHdoZXRoZXIgYmluYXJ5IGFycmF5IGVuZHMgd2l0aCBzdWZmaXguXG4gKiBAcGFyYW0gc291cmNlIHNvdXJjZSBhcnJheVxuICogQHBhcmFtIHN1ZmZpeCBzdWZmaXggYXJyYXkgdG8gY2hlY2sgaW4gc291cmNlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbmRzV2l0aChzb3VyY2U6IFVpbnQ4QXJyYXksIHN1ZmZpeDogVWludDhBcnJheSk6IGJvb2xlYW4ge1xuICBmb3IgKFxuICAgIGxldCBzcmNpID0gc291cmNlLmxlbmd0aCAtIDEsIHNmeGkgPSBzdWZmaXgubGVuZ3RoIC0gMTtcbiAgICBzZnhpID49IDA7XG4gICAgc3JjaS0tLCBzZnhpLS1cbiAgKSB7XG4gICAgaWYgKHNvdXJjZVtzcmNpXSAhPT0gc3VmZml4W3NmeGldKSByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKiBSZXBlYXQgYnl0ZXMuIHJldHVybnMgYSBuZXcgYnl0ZSBzbGljZSBjb25zaXN0aW5nIG9mIGBjb3VudGAgY29waWVzIG9mIGBiYC5cbiAqIEBwYXJhbSBvcmlnaW4gVGhlIG9yaWdpbiBieXRlc1xuICogQHBhcmFtIGNvdW50IFRoZSBjb3VudCB5b3Ugd2FudCB0byByZXBlYXQuXG4gKiBAdGhyb3dzIGBSYW5nZUVycm9yYCBXaGVuIGNvdW50IGlzIG5lZ2F0aXZlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXBlYXQob3JpZ2luOiBVaW50OEFycmF5LCBjb3VudDogbnVtYmVyKTogVWludDhBcnJheSB7XG4gIGlmIChjb3VudCA9PT0gMCkge1xuICAgIHJldHVybiBuZXcgVWludDhBcnJheSgpO1xuICB9XG5cbiAgaWYgKGNvdW50IDwgMCkge1xuICAgIHRocm93IG5ldyBSYW5nZUVycm9yKFwiYnl0ZXM6IG5lZ2F0aXZlIHJlcGVhdCBjb3VudFwiKTtcbiAgfSBlbHNlIGlmICgob3JpZ2luLmxlbmd0aCAqIGNvdW50KSAvIGNvdW50ICE9PSBvcmlnaW4ubGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiYnl0ZXM6IHJlcGVhdCBjb3VudCBjYXVzZXMgb3ZlcmZsb3dcIik7XG4gIH1cblxuICBjb25zdCBpbnQgPSBNYXRoLmZsb29yKGNvdW50KTtcblxuICBpZiAoaW50ICE9PSBjb3VudCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcImJ5dGVzOiByZXBlYXQgY291bnQgbXVzdCBiZSBhbiBpbnRlZ2VyXCIpO1xuICB9XG5cbiAgY29uc3QgbmIgPSBuZXcgVWludDhBcnJheShvcmlnaW4ubGVuZ3RoICogY291bnQpO1xuXG4gIGxldCBicCA9IGNvcHkob3JpZ2luLCBuYik7XG5cbiAgZm9yICg7IGJwIDwgbmIubGVuZ3RoOyBicCAqPSAyKSB7XG4gICAgY29weShuYi5zbGljZSgwLCBicCksIG5iLCBicCk7XG4gIH1cblxuICByZXR1cm4gbmI7XG59XG5cbi8qKiBDb25jYXRlbmF0ZSBtdWx0aXBsZSBiaW5hcnkgYXJyYXlzIGFuZCByZXR1cm4gbmV3IG9uZS5cbiAqIEBwYXJhbSBidWYgYmluYXJ5IGFycmF5cyB0byBjb25jYXRlbmF0ZVxuICovXG5leHBvcnQgZnVuY3Rpb24gY29uY2F0KC4uLmJ1ZjogVWludDhBcnJheVtdKTogVWludDhBcnJheSB7XG4gIGxldCBsZW5ndGggPSAwO1xuICBmb3IgKGNvbnN0IGIgb2YgYnVmKSB7XG4gICAgbGVuZ3RoICs9IGIubGVuZ3RoO1xuICB9XG5cbiAgY29uc3Qgb3V0cHV0ID0gbmV3IFVpbnQ4QXJyYXkobGVuZ3RoKTtcbiAgbGV0IGluZGV4ID0gMDtcbiAgZm9yIChjb25zdCBiIG9mIGJ1Zikge1xuICAgIG91dHB1dC5zZXQoYiwgaW5kZXgpO1xuICAgIGluZGV4ICs9IGIubGVuZ3RoO1xuICB9XG5cbiAgcmV0dXJuIG91dHB1dDtcbn1cblxuLyoqIENoZWNrIHNvdXJjZSBhcnJheSBjb250YWlucyBwYXR0ZXJuIGFycmF5LlxuICogQHBhcmFtIHNvdXJjZSBzb3VyY2UgYXJyYXlcbiAqIEBwYXJhbSBwYXQgcGF0dGVyIGFycmF5XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb250YWlucyhzb3VyY2U6IFVpbnQ4QXJyYXksIHBhdDogVWludDhBcnJheSk6IGJvb2xlYW4ge1xuICByZXR1cm4gaW5kZXhPZihzb3VyY2UsIHBhdCkgIT0gLTE7XG59XG5cbi8qKlxuICogQ29weSBieXRlcyBmcm9tIG9uZSBVaW50OEFycmF5IHRvIGFub3RoZXIuICBCeXRlcyBmcm9tIGBzcmNgIHdoaWNoIGRvbid0IGZpdFxuICogaW50byBgZHN0YCB3aWxsIG5vdCBiZSBjb3BpZWQuXG4gKlxuICogQHBhcmFtIHNyYyBTb3VyY2UgYnl0ZSBhcnJheVxuICogQHBhcmFtIGRzdCBEZXN0aW5hdGlvbiBieXRlIGFycmF5XG4gKiBAcGFyYW0gb2ZmIE9mZnNldCBpbnRvIGBkc3RgIGF0IHdoaWNoIHRvIGJlZ2luIHdyaXRpbmcgdmFsdWVzIGZyb20gYHNyY2AuXG4gKiBAcmV0dXJuIG51bWJlciBvZiBieXRlcyBjb3BpZWRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvcHkoc3JjOiBVaW50OEFycmF5LCBkc3Q6IFVpbnQ4QXJyYXksIG9mZiA9IDApOiBudW1iZXIge1xuICBvZmYgPSBNYXRoLm1heCgwLCBNYXRoLm1pbihvZmYsIGRzdC5ieXRlTGVuZ3RoKSk7XG4gIGNvbnN0IGRzdEJ5dGVzQXZhaWxhYmxlID0gZHN0LmJ5dGVMZW5ndGggLSBvZmY7XG4gIGlmIChzcmMuYnl0ZUxlbmd0aCA+IGRzdEJ5dGVzQXZhaWxhYmxlKSB7XG4gICAgc3JjID0gc3JjLnN1YmFycmF5KDAsIGRzdEJ5dGVzQXZhaWxhYmxlKTtcbiAgfVxuICBkc3Quc2V0KHNyYywgb2ZmKTtcbiAgcmV0dXJuIHNyYy5ieXRlTGVuZ3RoO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLEVBQUEsd0VBQUE7QUFFQSxFQUlBLEFBSkEscU5BSUEsQUFKQSxFQUlBLGlCQUNBLE9BQUEsQ0FDQSxNQUFBLEVBQ0EsR0FBQSxFQUNBLEtBQUEsR0FBQSxDQUFBO1FBRUEsS0FBQSxJQUFBLE1BQUEsQ0FBQSxNQUFBO2dCQUNBLENBQUE7O1FBRUEsS0FBQSxHQUFBLENBQUE7QUFDQSxhQUFBLEdBQUEsQ0FBQTs7VUFFQSxDQUFBLEdBQUEsR0FBQSxDQUFBLENBQUE7WUFDQSxDQUFBLEdBQUEsS0FBQSxFQUFBLENBQUEsR0FBQSxNQUFBLENBQUEsTUFBQSxFQUFBLENBQUE7WUFDQSxNQUFBLENBQUEsQ0FBQSxNQUFBLENBQUE7Y0FDQSxHQUFBLEdBQUEsQ0FBQTtZQUNBLE9BQUEsR0FBQSxDQUFBO1lBQ0EsQ0FBQSxHQUFBLENBQUE7Y0FDQSxPQUFBLEdBQUEsR0FBQSxDQUFBLE1BQUE7QUFDQSxhQUFBO2dCQUNBLE1BQUEsQ0FBQSxDQUFBLE1BQUEsR0FBQSxDQUFBLENBQUEsR0FBQSxHQUFBOzs7QUFHQSxtQkFBQTs7WUFFQSxPQUFBLEtBQUEsR0FBQSxDQUFBLE1BQUE7bUJBQ0EsR0FBQTs7O1lBR0EsQ0FBQTs7QUFHQSxFQUlBLEFBSkEscU5BSUEsQUFKQSxFQUlBLGlCQUNBLFdBQUEsQ0FDQSxNQUFBLEVBQ0EsR0FBQSxFQUNBLEtBQUEsR0FBQSxNQUFBLENBQUEsTUFBQSxHQUFBLENBQUE7UUFFQSxLQUFBLEdBQUEsQ0FBQTtnQkFDQSxDQUFBOztRQUVBLEtBQUEsSUFBQSxNQUFBLENBQUEsTUFBQTtBQUNBLGFBQUEsR0FBQSxNQUFBLENBQUEsTUFBQSxHQUFBLENBQUE7O1VBRUEsQ0FBQSxHQUFBLEdBQUEsQ0FBQSxHQUFBLENBQUEsTUFBQSxHQUFBLENBQUE7WUFDQSxDQUFBLEdBQUEsS0FBQSxFQUFBLENBQUEsSUFBQSxDQUFBLEVBQUEsQ0FBQTtZQUNBLE1BQUEsQ0FBQSxDQUFBLE1BQUEsQ0FBQTtjQUNBLEdBQUEsR0FBQSxDQUFBO1lBQ0EsT0FBQSxHQUFBLENBQUE7WUFDQSxDQUFBLEdBQUEsQ0FBQTtjQUNBLE9BQUEsR0FBQSxHQUFBLENBQUEsTUFBQTtBQUNBLGFBQUE7Z0JBQ0EsTUFBQSxDQUFBLENBQUEsTUFBQSxHQUFBLENBQUEsR0FBQSxDQUFBLE1BQUEsR0FBQSxDQUFBLElBQUEsR0FBQSxHQUFBLENBQUE7OztBQUdBLG1CQUFBOztZQUVBLE9BQUEsS0FBQSxHQUFBLENBQUEsTUFBQTttQkFDQSxHQUFBLEdBQUEsR0FBQSxDQUFBLE1BQUEsR0FBQSxDQUFBOzs7WUFHQSxDQUFBOztBQUdBLEVBR0EsQUFIQSw2SUFHQSxBQUhBLEVBR0EsaUJBQ0EsTUFBQSxDQUFBLENBQUEsRUFBQSxDQUFBO1FBQ0EsQ0FBQSxDQUFBLE1BQUEsS0FBQSxDQUFBLENBQUEsTUFBQSxTQUFBLEtBQUE7WUFDQSxDQUFBLEdBQUEsQ0FBQSxFQUFBLENBQUEsR0FBQSxDQUFBLENBQUEsTUFBQSxFQUFBLENBQUE7WUFDQSxDQUFBLENBQUEsQ0FBQSxNQUFBLENBQUEsQ0FBQSxDQUFBLFVBQUEsS0FBQTs7V0FFQSxJQUFBOztBQUdBLEVBR0EsQUFIQSxpSUFHQSxBQUhBLEVBR0EsaUJBQ0EsVUFBQSxDQUFBLE1BQUEsRUFBQSxNQUFBO1lBQ0EsQ0FBQSxHQUFBLENBQUEsRUFBQSxHQUFBLEdBQUEsTUFBQSxDQUFBLE1BQUEsRUFBQSxDQUFBLEdBQUEsR0FBQSxFQUFBLENBQUE7WUFDQSxNQUFBLENBQUEsQ0FBQSxNQUFBLE1BQUEsQ0FBQSxDQUFBLFVBQUEsS0FBQTs7V0FFQSxJQUFBOztBQUdBLEVBR0EsQUFIQSwrSEFHQSxBQUhBLEVBR0EsaUJBQ0EsUUFBQSxDQUFBLE1BQUEsRUFBQSxNQUFBO1lBRUEsSUFBQSxHQUFBLE1BQUEsQ0FBQSxNQUFBLEdBQUEsQ0FBQSxFQUFBLElBQUEsR0FBQSxNQUFBLENBQUEsTUFBQSxHQUFBLENBQUEsRUFDQSxJQUFBLElBQUEsQ0FBQSxFQUNBLElBQUEsSUFBQSxJQUFBO1lBRUEsTUFBQSxDQUFBLElBQUEsTUFBQSxNQUFBLENBQUEsSUFBQSxVQUFBLEtBQUE7O1dBRUEsSUFBQTs7QUFHQSxFQUlBLEFBSkEsOE1BSUEsQUFKQSxFQUlBLGlCQUNBLE1BQUEsQ0FBQSxNQUFBLEVBQUEsS0FBQTtRQUNBLEtBQUEsS0FBQSxDQUFBO21CQUNBLFVBQUE7O1FBR0EsS0FBQSxHQUFBLENBQUE7a0JBQ0EsVUFBQSxFQUFBLDRCQUFBO2VBQ0EsTUFBQSxDQUFBLE1BQUEsR0FBQSxLQUFBLEdBQUEsS0FBQSxLQUFBLE1BQUEsQ0FBQSxNQUFBO2tCQUNBLEtBQUEsRUFBQSxtQ0FBQTs7VUFHQSxHQUFBLEdBQUEsSUFBQSxDQUFBLEtBQUEsQ0FBQSxLQUFBO1FBRUEsR0FBQSxLQUFBLEtBQUE7a0JBQ0EsS0FBQSxFQUFBLHNDQUFBOztVQUdBLEVBQUEsT0FBQSxVQUFBLENBQUEsTUFBQSxDQUFBLE1BQUEsR0FBQSxLQUFBO1FBRUEsRUFBQSxHQUFBLElBQUEsQ0FBQSxNQUFBLEVBQUEsRUFBQTtVQUVBLEVBQUEsR0FBQSxFQUFBLENBQUEsTUFBQSxFQUFBLEVBQUEsSUFBQSxDQUFBO0FBQ0EsWUFBQSxDQUFBLEVBQUEsQ0FBQSxLQUFBLENBQUEsQ0FBQSxFQUFBLEVBQUEsR0FBQSxFQUFBLEVBQUEsRUFBQTs7V0FHQSxFQUFBOztBQUdBLEVBRUEsQUFGQSxxR0FFQSxBQUZBLEVBRUEsaUJBQ0EsTUFBQSxJQUFBLEdBQUE7UUFDQSxNQUFBLEdBQUEsQ0FBQTtlQUNBLENBQUEsSUFBQSxHQUFBO0FBQ0EsY0FBQSxJQUFBLENBQUEsQ0FBQSxNQUFBOztVQUdBLE1BQUEsT0FBQSxVQUFBLENBQUEsTUFBQTtRQUNBLEtBQUEsR0FBQSxDQUFBO2VBQ0EsQ0FBQSxJQUFBLEdBQUE7QUFDQSxjQUFBLENBQUEsR0FBQSxDQUFBLENBQUEsRUFBQSxLQUFBO0FBQ0EsYUFBQSxJQUFBLENBQUEsQ0FBQSxNQUFBOztXQUdBLE1BQUE7O0FBR0EsRUFHQSxBQUhBLHVHQUdBLEFBSEEsRUFHQSxpQkFDQSxRQUFBLENBQUEsTUFBQSxFQUFBLEdBQUE7V0FDQSxPQUFBLENBQUEsTUFBQSxFQUFBLEdBQUEsTUFBQSxDQUFBOztBQUdBLEVBUUEsQUFSQSw0U0FRQSxBQVJBLEVBUUEsaUJBQ0EsSUFBQSxDQUFBLEdBQUEsRUFBQSxHQUFBLEVBQUEsR0FBQSxHQUFBLENBQUE7QUFDQSxPQUFBLEdBQUEsSUFBQSxDQUFBLEdBQUEsQ0FBQSxDQUFBLEVBQUEsSUFBQSxDQUFBLEdBQUEsQ0FBQSxHQUFBLEVBQUEsR0FBQSxDQUFBLFVBQUE7VUFDQSxpQkFBQSxHQUFBLEdBQUEsQ0FBQSxVQUFBLEdBQUEsR0FBQTtRQUNBLEdBQUEsQ0FBQSxVQUFBLEdBQUEsaUJBQUE7QUFDQSxXQUFBLEdBQUEsR0FBQSxDQUFBLFFBQUEsQ0FBQSxDQUFBLEVBQUEsaUJBQUE7O0FBRUEsT0FBQSxDQUFBLEdBQUEsQ0FBQSxHQUFBLEVBQUEsR0FBQTtXQUNBLEdBQUEsQ0FBQSxVQUFBIn0=