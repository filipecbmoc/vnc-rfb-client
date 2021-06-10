class Raw {

    constructor(debug = false, debugLevel = 1) {
        this.debug = debug;
        this.debugLevel = debugLevel;
    }

    getPixelBytePos(x, y, width, height) {
        return ((y * width) + x) * 4;
    }

    decode(rect, fb, bitsPerPixel, colorMap, screenW, screenH, socket, depth, red, green, blue) {
        return new Promise(async (resolve, reject) => {

            await socket.waitBytes(rect.width * rect.height * (bitsPerPixel / 8), 'Raw pixel data');
            rect.data = socket.readNBytesOffset(rect.width * rect.height * (bitsPerPixel / 8));

            for (let h = 0; h < rect.height; h++) {
                for (let w = 0; w < rect.width; w++) {
                    const fbBytePosOffset = this.getPixelBytePos(rect.x + w, rect.y + h, screenW, screenH);
                    if (bitsPerPixel === 8) {
                        const bytePosOffset = (h * rect.width) + w;
                        const index = rect.data.readUInt8(bytePosOffset);
                        const color = colorMap[index];
                        fb.writeIntBE(color, fbBytePosOffset, 4);
                    } else if (bitsPerPixel === 24) {
                        const bytePosOffset = ((h * rect.width) + w) * 3;
                        fb.writeUInt8(rect.data.readUInt8(bytePosOffset + red), fbBytePosOffset);
                        fb.writeUInt8(rect.data.readUInt8(bytePosOffset + green), fbBytePosOffset + 1);
                        fb.writeUInt8(rect.data.readUInt8(bytePosOffset + blue), fbBytePosOffset + 2);
                        fb.writeUInt8(255, fbBytePosOffset + 3);
                    } else if (bitsPerPixel === 32) {
                        const bytePosOffset = ((h * rect.width) + w) * 4;
                        fb.writeUInt8(rect.data.readUInt8(bytePosOffset + red), fbBytePosOffset + 2);
                        fb.writeUInt8(rect.data.readUInt8(bytePosOffset + green), fbBytePosOffset + 1);
                        fb.writeUInt8(rect.data.readUInt8(bytePosOffset + blue), fbBytePosOffset);
                        fb.writeUInt8(255, fbBytePosOffset + 3);
                    }
                }
            }
            resolve();
        });
    }

}

module.exports = Raw;
