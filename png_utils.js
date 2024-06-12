/**
 * A collection of useful functions for parsing PNG files.
 */
class png {

    /**
     * Create chunked data from file.
     * @param {Event} event The event object containing the file input.
     * @constructor Returns a promise for a png object which includes the raw PNG image data.
     */
    constructor(event) {
        if (!typeof event === "object" || event === "null") {
            throw new Error("Invalid target.");
        }
        if (event.target.files[0].type !== "image/png") {
            throw new Error("Supplied files have to be of type image/png.");
        }
        this.data = null;
        return (async () => {
            await this.#initialize(event);
            //The first eight bytes of a PNG datastream always contain the following (decimal) values.
            this.data.signature = "137 80 78 71 13 10 26 10";
            return this;
        })();
    }

    /**
     * Initializes the PNG object with raw data.
     * @param {Event} event The event object containing the file input. 
     * @private
     */
    async #initialize(event) {
        const arrayBuffer = await this.#readBlob(event);
        const { chunks: data } = await this.parseChunks(arrayBuffer);
        this.data = data;
    }

    /**
     * Read the file blob as an ArrayBuffer.
     * @param {Event} event The event object containing the file input.
     * @returns {Promise<ArrayBuffer>} The PNG file data as an ArrayBuffer.
     * @private
     */
    async #readBlob(event) {
        let file;
        if (event.target) { file = event.target.files[0]; } else {
            //Presume the argument passed was a file.
            file = event;
        }
        let fr = new FileReader();
        return new Promise((resolve, reject) => {
            fr.onload = () => {
                resolve(fr.result);
            };
            fr.onerror = reject;
            fr.readAsArrayBuffer(file, "UTF-8");
        });
    }
    /**
     * Parse raw PNG data and chunk them.
     * [PNG Specification](http://www.libpng.org/pub/png/spec/iso/index-object.html#11Chunks)
     * @param {ArrayBuffer} arrayBuffer The raw PNG file data.
     * @returns {Promise<Object>}
     */
    async parseChunks(arrayBuffer) {

        let dataView = new DataView(arrayBuffer);

        let bytes = [];
        for (let i = 0; i < dataView.byteLength; i++) {
            bytes.push(dataView.getUint8(i));
        }

        let utf8Decode = new TextDecoder("utf-8");
        let chunks = [];
        let data;
        //First 8 bytes are the file signature which should be added back by the user after modifying the image.
        let pos = 8;
        let size, crc, offset, fourCC;

        while (pos < arrayBuffer.byteLength) {
            size = dataView.getUint32(pos);
            // fourcc
            fourCC = utf8Decode.decode(new Uint8Array(bytes.slice(pos + 4, pos + 8)));
            // data offset
            offset = pos + 8;
            pos = offset + size;
            // crc
            crc = dataView.getUint32(pos);
            pos += 4;

            data = bytes.slice(offset, offset + size)
            // store chunk
            switch (fourCC) {
                case "IHDR": {
                    chunks.push({
                        fourCC: fourCC,
                        size: size,//Only size of data, excluding fourCC and CRC
                        data: data,
                        offset: offset,
                        crc: crc,
                        chunkInfo: {
                            widthPixels: dataView.getUint32(16),
                            heightPixels: dataView.getUint32(20),
                            bitDepth: dataView.getUint8(24),
                            colourType: dataView.getUint8(25),
                            compressionMethod: dataView.getInt8(26),
                            filterMethod: dataView.getUint8(27),
                            interlaceMethod: dataView.getUint8(28),
                        },
                    });
                    break;
                }
                case "PLTE":
                    if (size % 3 !== 0) {
                        throw new Error("PLTE chunk length must be divisible by 3.")
                    }
                    if (chunks[0].chunkInfo.colourType === 3 && size === 0) {
                        throw new Error("Images of colourtype 3 must include a PLTE chunk.")
                    } else if ((chunks[0].chunkInfo.colourType === 0 || chunks[0].chunkInfo.colourType === 4) && size !== 0) {
                        console.warn(`Images of colourtype ${chunks[0].chunkInfo.colourType} shouldn't have PLTE chunks. It will be ignored.`)
                    }
                    chunks.push({
                        fourCC: fourCC,
                        size: size,//Only size of data, excluding fourCC and CRC
                        data: data,
                        offset: offset,
                        crc: crc,
                    });
                    break;
                case "tRNS":
                    chunks.push({
                        fourCC: fourCC,
                        size: size,//Only size of data, excluding fourCC and CRC
                        data: data,
                        offset: offset,
                        crc: crc,
                    });
                    break;
            default: {
                chunks.push({
                    fourCC: fourCC,
                    size: size,//Only size of data, excluding fourCC and CRC
                    data: data,
                    offset: offset,
                    crc: crc,
                });
            }
            }

        }

        return { chunks: chunks };
    }
    /**
     * Concatenate all IDAT chunks.
     * @returns {Uint8Array}
     * @private
     */
    #concatIDATChunks() {
        let idatData = [];
        for (let chunk of this.data) {
            if (chunk.fourCC === "IDAT") {
                idatData = idatData.concat(chunk.data);
            }
        }
        return new Uint8Array(idatData);
    }
    /**
     * Decompress IDAT data.
     * @returns {Promise<Uint8Array>}
     */
    async decompressIDATData() {
        const idatData = this.#concatIDATChunks();

        const idatStream = new ReadableStream({
            start(controller) {
                controller.enqueue(idatData);
                controller.close();
            }
        });

        const decompressStream = new DecompressionStream('deflate');
        const decompressedStream = idatStream.pipeThrough(decompressStream);
        const reader = decompressedStream.getReader();
        let chunks = [];
        let done, value;

        while ({ done, value } = await reader.read(), !done) {
            chunks.push(value);
        }

        let dataBuffer = new Uint8Array(chunks.reduce((acc, val) => acc + val.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
            dataBuffer.set(chunk, offset);
            offset += chunk.length;
        }

        return Array.from(dataBuffer);
    }
    /**
     * Compress data using inflate algorithm.
     * @returns {Promise<Uint8Array>}
     */
    async compressIDATData() {
        const idatData = this.#concatIDATChunks();

        const idatStream = new ReadableStream({
            start(controller) {
                controller.enqueue(idatData);
                controller.close();
            }
        });
        
        const compressionStream = idatStream.pipeThrough(new CompressionStream('deflate'));
        const reader = compressionStream.getReader();
        
        let chunks = [];
        let done, value;
        while ({ done, value } = await reader.read(), !done) {
            chunks.push(value);
        }
        let dataBuffer = new Uint8Array(chunks.reduce((acc, val) => acc + val.length, 0));
        let offset = 0;
        for (let chunk of chunks) {
            dataBuffer.set(chunk, offset);
            offset += chunk.length;
        }

        return dataBuffer;
    }

    /**
     * Reconstructs the original, unfiltered values for each pixel in an ArrayBuffer.
     * [PNG Specification](http://www.libpng.org/pub/png/spec/iso/index-object.html#9Filters)
     * @param {ArrayBuffer} arrayBuffer The filtered pixel data.
     * @throws Will throw an error if the filter byte of a line is incorrect.
     * @returns {Array} The unfiltered pixel data.
     */
    reverseFiltering(arrayBuffer) {
        const array = Array.from(arrayBuffer);
        const { widthPixels } = this.data[0].chunkInfo;
        const widthBytes = (widthPixels * 4) + 1;
        const res = [];
        let lineNum = -1;
        let pixelCount = 0;
        let filterByte;

        for (let i = 0; i < array.length; i += 4) {
            // Start of a new line
            if (i % widthBytes === 0) {
                filterByte = array[i++];
                res[++lineNum] = [filterByte];
                pixelCount = 0;
            }

            const curPixel = array.slice(i, i + 4);
            let prevPixel = res[lineNum][pixelCount];
            let prevLinePixel = lineNum > 0 ? res[lineNum - 1][pixelCount + 1] : [0, 0, 0, 0];

            switch (filterByte) {
                case 0:
                    res[lineNum].push(curPixel);
                    break;
                case 1:
                    if (pixelCount > 0) {
                        const subPixel = curPixel.map((x, idx) => (x + prevPixel[idx]) % 256);
                        res[lineNum].push(subPixel);
                        prevPixel = subPixel;
                    } else {
                        res[lineNum].push(curPixel);
                        prevPixel = curPixel;
                    }
                    break;
                case 2:
                    const upPixel = curPixel.map((x, idx) => (x + prevLinePixel[idx]) % 256);
                    res[lineNum].push(upPixel);
                    break;
                case 3:
                    const avgPixel = curPixel.map((x, idx) => {
                        const left = pixelCount > 0 ? prevPixel[idx] : 0;
                        const up = lineNum > 0 ? prevLinePixel[idx] : 0;
                        return (x + Math.floor((left + up) / 2)) % 256;
                    });
                    res[lineNum].push(avgPixel);
                    break;
                case 4:
                    const paethPixel = curPixel.map((x, idx) => {
                        const a = pixelCount > 0 ? prevPixel[idx] : 0;
                        const b = lineNum > 0 ? prevLinePixel[idx] : 0;
                        const c = (pixelCount > 0 && lineNum > 0) ? res[lineNum - 1][pixelCount][idx] : 0;
                        const p = a + b - c;
                        const pa = Math.abs(p - a);
                        const pb = Math.abs(p - b);
                        const pc = Math.abs(p - c);
                        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                        return (x + pr) % 256;
                    });
                    res[lineNum].push(paethPixel);
                    break;
                default:
                    throw new Error("Unexpected filter byte.");
            }

            pixelCount++;
        }

        return res;
    }
    /**
     * Extracts sub-images.
     * @param {Array<Array<Number>>} imageDataBuffer Expects unfiltered RGBA values.
     * @param {{x:number,y:number}} tileSize 
     * @param {{xMargin:number,yMargin:number}} margins The margins around the image.
     * @throws Will throw an error if the arguments passed to subImage are incorrect.
     * @throws Will throw an error if it fails to extract a sub-image for whatever reason.
     */
    subImage(imageDataBuffer, tileSize, margins = { xMargin: 0, yMargin: 0 }) {
        if (!Array.isArray(imageDataBuffer)) {
            throw new Error(`Incorrect type for imageDataBuffer. Type of ${typeof imageDataBuffer}`);
        }
        if (typeof tileSize !== 'object' || !('x' in tileSize) || !('y' in tileSize) || typeof tileSize.x !== 'number' || typeof tileSize.y !== 'number' || tileSize.x <= 0 || tileSize.y <= 0) {
            throw new Error(`Invalid tileSize: ${JSON.stringify(tileSize)}.`);
        }
        if (typeof margins !== 'object' || typeof margins.xMargin !== 'number' || typeof margins.yMargin !== 'number') {
            throw new Error(`Invalid margins: ${JSON.stringify(margins)}.`);
        }
        const { xMargin, yMargin } = margins;
        const { x: tileWidth, y: tileHeight } = tileSize;
        //Add zero as first element to represent the filter byte.
        let subImage = [0];
        try {
            for (let i = yMargin; i < tileHeight + yMargin; i++) {
                subImage.push(imageDataBuffer[i].slice(xMargin + 1, xMargin + 1 + tileWidth));
            }
        } catch (e) {
            throw new Error(`Error trying to get subimage. ${e.message}`);
        }
        return subImage;
    }

}