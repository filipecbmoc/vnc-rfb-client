class Hextile {

    constructor() {

    }

    getPixelBytePos(x, y, width, height) {
        return ((y * width) + x) * 4;
    }

    decode(rect, fb, bitsPerPixel, colorMap, screenW, screenH, socket, depth) {
        return new Promise(async (resolve, reject) => {

            const initialOffset = socket.offset;
            let dataSize = 0;

            let tiles;
            let totalTiles;
            let tilesX;
            let tilesY;

            let lastSubEncoding;

            const backgroundColor = {r: 0, g: 0, b: 0, a: 255};
            const foregroundColor = {r: 0, g: 0, b: 0, a: 255};

            tilesX = Math.ceil(rect.width / 16);
            tilesY = Math.ceil(rect.height / 16);
            tiles = tilesX * tilesY;
            totalTiles = tiles;

            while (tiles) {

                await socket.waitBytes(1);
                const subEncoding = socket.readUInt8();
                dataSize++;
                const currTile = totalTiles - tiles;

                // Calculate tile position and size
                const tileX = currTile % tilesX;
                const tileY = Math.floor(currTile / tilesX);
                const tx = rect.x + (tileX * 16);
                const ty = rect.y + (tileY * 16);
                const tw = Math.min(16, (rect.x + rect.width) - tx);
                const th = Math.min(16, (rect.y + rect.height) - ty);

                if (subEncoding === 0) {
                    if (lastSubEncoding & 0x01) {
                        // We need to ignore zeroed tile after a raw tile
                    } else {
                        // If zeroed tile and last tile was not raw, use the last backgroundColor
                        this.applyColor(tw, th, tx, ty, screenW, screenH, backgroundColor, fb);
                    }
                } else if (subEncoding & 0x01) {
                    // If Raw, ignore all other bits
                    await socket.waitBytes(th * tw * (bitsPerPixel / 8));
                    dataSize += th * tw * (bitsPerPixel / 8);
                    for (let h = 0; h < th; h++) {
                        for (let w = 0; w < tw; w++) {
                            const fbBytePosOffset = this.getPixelBytePos(tx + w, ty + h, screenW, screenH);
                            if (bitsPerPixel === 8) {
                                const index = socket.readUInt8();
                                const color = colorMap[index];
                                // RGB
                                // fb.writeUInt8(color?.r || 255, fbBytePosOffset);
                                // fb.writeUInt8(color?.g || 255, fbBytePosOffset + 1);
                                // fb.writeUInt8(color?.b || 255, fbBytePosOffset + 2);

                                // BGR
                                fb.writeUInt8(color?.r || 255, fbBytePosOffset + 2);
                                fb.writeUInt8(color?.g || 255, fbBytePosOffset + 1);
                                fb.writeUInt8(color?.b || 255, fbBytePosOffset);
                            } else if (bitsPerPixel === 24) {
                                fb.writeUInt8(socket.readUInt8(), fbBytePosOffset);
                                fb.writeUInt8(socket.readUInt8(), fbBytePosOffset + 1);
                                fb.writeUInt8(socket.readUInt8(), fbBytePosOffset + 2);
                            } else if (bitsPerPixel === 32) {
                                // RGB
                                // fb.writeUInt8(rect.data.readUInt8(bytePosOffset), fbBytePosOffset);
                                // fb.writeUInt8(rect.data.readUInt8(bytePosOffset + 1), fbBytePosOffset + 1);
                                // fb.writeUInt8(rect.data.readUInt8(bytePosOffset + 2), fbBytePosOffset + 2);

                                // BGR
                                fb.writeUInt8(socket.readUInt8(), fbBytePosOffset + 2);
                                fb.writeUInt8(socket.readUInt8(), fbBytePosOffset + 1);
                                fb.writeUInt8(socket.readUInt8(), fbBytePosOffset);
                                socket.readUInt8();
                            }
                            // Alpha, always 255
                            fb.writeUInt8(255, fbBytePosOffset + 3);
                        }
                    }
                    lastSubEncoding = subEncoding;
                } else {
                    // Background bit
                    if (subEncoding & 0x02) {
                        switch (bitsPerPixel) {
                            case 8:
                                await socket.waitBytes(1);
                                const index = socket.readUInt8();
                                dataSize++;
                                backgroundColor.r = colorMap[index].r || 255;
                                backgroundColor.g = colorMap[index].g || 255;
                                backgroundColor.b = colorMap[index].b || 255;
                                break;

                            case 24:
                                await socket.waitBytes(3);
                                dataSize += 3;
                                backgroundColor.r = socket.readUInt8();
                                backgroundColor.g = socket.readUInt8();
                                backgroundColor.b = socket.readUInt8();
                                break;

                            case 32:
                                await socket.waitBytes(4);
                                dataSize += 4;
                                backgroundColor.r = socket.readUInt8();
                                backgroundColor.g = socket.readUInt8();
                                backgroundColor.b = socket.readUInt8();
                                backgroundColor.a = socket.readUInt8();
                                break;

                        }
                    }

                    // Foreground bit
                    if (subEncoding & 0x04) {
                        switch (bitsPerPixel) {
                            case 8:
                                await socket.waitBytes(1);
                                const index = socket.readUInt8();
                                dataSize++;
                                foregroundColor.r = colorMap[index].r || 255;
                                foregroundColor.g = colorMap[index].g || 255;
                                foregroundColor.b = colorMap[index].b || 255;
                                break;

                            case 24:
                                await socket.waitBytes(3);
                                dataSize += 3;
                                foregroundColor.r = socket.readUInt8();
                                foregroundColor.g = socket.readUInt8();
                                foregroundColor.b = socket.readUInt8();
                                break;

                            case 32:
                                await socket.waitBytes(4);
                                dataSize += 4;
                                foregroundColor.r = socket.readUInt8();
                                foregroundColor.g = socket.readUInt8();
                                foregroundColor.b = socket.readUInt8();
                                foregroundColor.a = socket.readUInt8();
                                break;

                        }
                    }

                    // Initialize tile with the background color
                    this.applyColor(tw, th, tx, ty, screenW, screenH, backgroundColor, fb);

                    // AnySubrects bit
                    if (subEncoding & 0x08) {

                        await socket.waitBytes(1);
                        let subRects = socket.readUInt8();

                        if (subRects) {

                            while (subRects) {

                                subRects--;
                                const color = {r: 0, g: 0, b: 0, a: 255};

                                // SubrectsColoured
                                if (subEncoding & 0x10) {

                                    switch (bitsPerPixel) {

                                        case 8:
                                            await socket.waitBytes(1);
                                            const index = socket.readUInt8();
                                            dataSize++;
                                            color.r = colorMap[index].r || 255;
                                            color.g = colorMap[index].g || 255;
                                            color.b = colorMap[index].b || 255;
                                            break;

                                        case 24:
                                            await socket.waitBytes(3);
                                            dataSize += 3;
                                            color.r = socket.readUInt8();
                                            color.g = socket.readUInt8();
                                            color.b = socket.readUInt8();
                                            break;

                                        case 32:
                                            await socket.waitBytes(4);
                                            dataSize += 4;
                                            color.r = socket.readUInt8();
                                            color.g = socket.readUInt8();
                                            color.b = socket.readUInt8();
                                            color.a = socket.readUInt8();
                                            break;
                                    }

                                } else {
                                    color.r = foregroundColor.r;
                                    color.g = foregroundColor.g;
                                    color.b = foregroundColor.b;
                                    color.a = foregroundColor.a;
                                }

                                await socket.waitBytes(2);
                                const xy = socket.readUInt8();
                                const wh = socket.readUInt8();
                                dataSize += 2;

                                const sx = (xy >> 4);
                                const sy = (xy & 0x0f);
                                const sw = (wh >> 4) + 1;
                                const sh = (wh & 0x0f) + 1;

                                this.applyColor(sw, sh, tx + sx, ty + sy, screenW, screenH, color, fb);

                            }

                        } else {
                            this.applyColor(tw, th, tx, ty, screenW, screenH, backgroundColor, fb);
                        }

                    } else {
                        this.applyColor(tw, th, tx, ty, screenW, screenH, backgroundColor, fb);
                    }

                    lastSubEncoding = subEncoding;

                }

                tiles--;

            }

            rect.data = socket.readNBytes(dataSize, initialOffset);
            resolve();
        });
    }

    // Apply color to a rect on buffer
    applyColor(tw, th, tx, ty, screenW, screenH, color, fb) {
        for (let h = 0; h < th; h++) {
            for (let w = 0; w < tw; w++) {
                const fbBytePosOffset = this.getPixelBytePos(tx + w, ty + h, screenW, screenH);
                fb.writeUInt8(color.r || 255, fbBytePosOffset + 2);
                fb.writeUInt8(color.g || 255, fbBytePosOffset + 1);
                fb.writeUInt8(color.b || 255, fbBytePosOffset);
                fb.writeUInt8(255, fbBytePosOffset + 3);
            }
        }
    }

}

module.exports = Hextile;
