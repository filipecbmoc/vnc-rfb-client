class CopyRect {

    constructor(debug = false, debugLevel = 1) {
        this.debug = debug;
        this.debugLevel = debugLevel;
    }

    getPixelBytePos(x, y, width, height) {
        return ((y * width) + x) * 4;
    }

    decode(rect, fb, bitsPerPixel, colorMap, screenW, screenH, socket, depth, red, green, blue) {
        return new Promise(async (resolve, reject) => {

            await socket.waitBytes(4);
            rect.data = socket.readNBytesOffset(4);

            const x = rect.data.readUInt16BE();
            const y = rect.data.readUInt16BE(2);

            for (let h = 0; h < rect.height; h++) {
                for (let w = 0; w < rect.width; w++) {

                    const fbOrigBytePosOffset = this.getPixelBytePos(x + w, y + h, screenW, screenH);
                    const fbBytePosOffset = this.getPixelBytePos(rect.x + w, rect.y + h, screenW, screenH);

                    fb.writeUInt8(fb.readUInt8(fbOrigBytePosOffset), fbBytePosOffset);
                    fb.writeUInt8(fb.readUInt8(fbOrigBytePosOffset + 1), fbBytePosOffset + 1);
                    fb.writeUInt8(fb.readUInt8(fbOrigBytePosOffset + 2), fbBytePosOffset + 2);
                    fb.writeUInt8(fb.readUInt8(fbOrigBytePosOffset + 3), fbBytePosOffset + 3);

                }
            }

            resolve();

        });
    }

}

module.exports = CopyRect;
