class Tight {

    constructor() {

    }

    getPixelBytePos(x, y, width, height) {
        return ((y * width) + x) * 4;
    }

    getDataSize(rect, socket, bitsPerPixel) {

    }

    // TODO: Implement tight encoding
    decode(rect, fb, bitsPerPixel, colorMap, screenW, screenH, socket) {
        return new Promise((resolve, reject) => {
            resolve();
        });
    }

}

module.exports = Tight;
