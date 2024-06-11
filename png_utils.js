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
            // store chunk
            if (fourCC === "IHDR") {
                chunks.push({
                    fourCC: fourCC,
                    size: size,//Only size of data, excluding fourCC and CRC
                    data: bytes.slice(offset, offset + size),
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
            } else {
                chunks.push({
                    fourCC: fourCC,
                    size: size,//Only size of data, excluding fourCC and CRC
                    data: bytes.slice(offset, offset + size),
                    offset: offset,
                    crc: crc,
                });
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
     * @param {ArrayBuffer} arrayBuffer - The data to be compressed.
     * @returns {Promise<Uint8Array>}
     */
    async compressIDATData(arrayBuffer) {
        const idatStream = new ReadableStream({
            start(controller) {
                controller.enqueue(arrayBuffer);
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
        arrayBuffer = Array.from(arrayBuffer);
        const { widthPixels } = this.data[0].chunkInfo;
        const widthBytes = (widthPixels * 4) + 1;
        let filterByte;
        //The first element of the inner array is the filter method integer.
        let res = [[]];
        let lineNum = -1;

        let tempArr;
        let pixelCount = 0;
        let curPixel;
        for (let i = 0; i < arrayBuffer.length; i += 4) {

            if (i % widthBytes === 0 || i === 0) {
                tempArr = arrayBuffer.slice(i, i + 4);
                filterByte = arrayBuffer[i];
                i++;
                pixelCount = 0;
                lineNum++;
            }
            if (res[lineNum] === undefined || res[lineNum].length === 0) {
                res[lineNum] = [filterByte];
                tempArr = arrayBuffer.slice(i, i + 4);
            }
            curPixel = arrayBuffer.slice(i, i + 4);

            switch (filterByte) {
                // 0 = None
                case 0:
                    res[lineNum].push(curPixel);
                    break;
                // 1 = Sub
                case 1:
                    if (i > widthBytes * (lineNum) + 3) {
                        let c = -1;

                        res[lineNum].push(curPixel.map((x) => {
                            c++;
                            let ret = x + tempArr[c];
                            if (ret >= 256) {
                                ret = ret - 256;
                            };
                            return ret;
                        }));
                        tempArr = res[lineNum][pixelCount + 1];
                    } else {
                        tempArr = curPixel;
                        res[lineNum].push(curPixel);
                    }
                    break;
                // 2 = up    
                case 2:
                    if (lineNum > 0) {
                        let c = 0;
                        res[lineNum].push(curPixel.map((x) => {
                            let ret = x + res[lineNum - 1][pixelCount + 1][c];
                            if (ret >= 256) {
                                ret -= 256;
                            };
                            c++;
                            return ret;
                        }));
                    } else {
                        tempArr = curPixel;
                        res[lineNum].push(curPixel);
                    }
                    break;
                // 3 = average
                case 3:

                    if (lineNum > 0 && i > widthBytes * (lineNum) + 3) {
                        let c = 0;
                        res[lineNum].push(curPixel.map((x) => {
                            let ret = x + ~~((res[lineNum][pixelCount + 1][c] + res[lineNum - 1][pixelCount + 1][c]) / 2);
                            if (ret >= 256) {
                                ret -= 256;
                            };
                            c++;
                            return ret;
                        }));
                    } else {
                        let c = 0;
                        let tmp = [0, 0, 0, 0];
                        if (!(lineNum > 0)) {
                            res[lineNum].push(curPixel.map((x) => {
                                let ret = x + ~~((res[lineNum][pixelCount + 1][c] + tmp[c]) / 2);
                                if (ret >= 256) {
                                    ret -= 256;
                                };
                                c++;
                                return ret;
                            }));
                        } else if (!(i > widthBytes * (lineNum) + 3)) {
                            let c = 0;
                            res[lineNum].push(curPixel.map((x) => {
                                let ret = x + ~~((tmp[c] + res[lineNum - 1][pixelCount + 1]) / 2);
                                if (ret >= 256) {
                                    ret -= 256;
                                };
                                c++;
                                return ret;
                            }));
                        }
                        else {
                            let c = 0;
                            res[lineNum].push(curPixel.map((x) => {
                                let ret = x + ~~((tmp[c] + tmp[c]) / 2);
                                if (ret >= 256) {
                                    ret -= 256;
                                }; c++;
                                return ret;
                            }));
                        }
                        tempArr = curPixel;
                        res[lineNum].push(curPixel);
                    }
                    break;
                // 4 = Paeth
                case 4:
                    let a, b, c;
                    if (lineNum > 0 && pixelCount !== 0) {
                        a = res[lineNum][pixelCount];
                        b = res[lineNum - 1][pixelCount + 1];
                        c = res[lineNum - 1][pixelCount];
                    } else if (pixelCount === 0 && lineNum > 0) {
                        a = [0, 0, 0, 0];
                        b = res[lineNum - 1][pixelCount + 1];
                        c = [0, 0, 0, 0];

                    } else if (pixelCount !== 0 & !(lineNum > 0)) {
                        a = res[lineNum][pixelCount];
                        b = [0, 0, 0, 0];
                        c = [0, 0, 0, 0];

                    } else {
                        a = [0, 0, 0, 0];
                        b = [0, 0, 0, 0];
                        c = [0, 0, 0, 0];
                    }


                    const p = a.reduce((acc, curr) => acc + curr) + b.reduce((acc, curr) => acc + curr) - c.reduce((acc, curr) => acc + curr);
                    const pa = Math.abs(p - a.reduce((acc, curr) => acc + curr));
                    const pb = Math.abs(p - b.reduce((acc, curr) => acc + curr));
                    const pc = Math.abs(p - c.reduce((acc, curr) => acc + curr));
                    let ret = [];
                    let ref;
                    if (pa <= pb && pa <= pc) {

                        for (let j = 0; j < 4; j++) {
                            ref = a[j] + curPixel[j];
                            if (ref >= 256) { ref -= 256; }
                            ret.push(ref);
                        }
                    } else if (pb <= pc) {
                        for (let j = 0; j < 4; j++) {
                            ref = b[j] + curPixel[j];
                            if (ref >= 256) { ref -= 256; }
                            ret.push(ref);
                        }
                    } else {
                        for (let j = 0; j < 4; j++) {
                            ref = c[j] + curPixel[j];
                            if (ref >= 256) { ref -= 256; }
                            ret.push(ref);
                        }
                    }


                    res[lineNum].push(ret);
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