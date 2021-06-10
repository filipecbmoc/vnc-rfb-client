const {versionString, encodings, serverMsgTypes} = require('./constants');
const net = require('net');
const Events = require('events').EventEmitter;

const HextileDecoder = require('./decoders/hextile');
const RawDecoder = require('./decoders/raw');
const ZrleDecoder = require('./decoders/zrle');
// const tightDecoder = require('./decoders/tight');
const CopyrectDecoder = require('./decoders/copyrect');
const SocketBuffer = require('./socketbuffer');
const crypto = require('crypto');

class VncClient extends Events {

    static get consts() {
        return {encodings};
    }

    /**
     * Return if client is connected
     * @returns {boolean}
     */
    get connected() {
        return this._connected;
    }

    /**
     * Return if client is authenticated
     * @returns {boolean}
     */
    get authenticated() {
        return this._authenticated;
    }

    /**
     * Return negotiated protocol version
     * @returns {string}
     */
    get protocolVersion() {
        return this._version;
    }

    /**
     * Return the local port used by the client
     * @returns {number}
     */
    get localPort() {
        return this._connection ? this._connection.localPort : 0;
    }

    constructor(options = {debug: true, fps: 0, encodings: [], debugLevel: 1}) {
        super();

        this._socketBuffer = new SocketBuffer();

        this.resetState();
        this.debug = options.debug || false;
        this.debugLevel = options.debugLevel || 1;
        this._fps = Number(options.fps) || 0;
        // Calculate interval to meet configured FPS
        this._timerInterval = this._fps > 0 ? 1000 / this._fps : 0;

        // Default encodings
        this.encodings = options.encodings && options.encodings.length ? options.encodings : [
            encodings.copyRect,
            encodings.zrle,
            encodings.hextile,
            encodings.raw,
            encodings.pseudoDesktopSize
        ];

        this._rects = 0;
        this._decoders = {};
        this._decoders[encodings.raw] = new RawDecoder(this.debug, this.debugLevel);
        // TODO: Implement tight encoding
        // this._decoders[encodings.tight] = new tightDecoder();
        this._decoders[encodings.zrle] = new ZrleDecoder(this.debug, this.debugLevel);
        this._decoders[encodings.copyRect] = new CopyrectDecoder(this.debug, this.debugLevel);
        this._decoders[encodings.hextile] = new HextileDecoder(this.debug, this.debugLevel);

        if (this._timerInterval) {
            this._fbTimer();
        }

    }

    /**
     * Timer used to limit the rate of frame update requests according to configured FPS
     * @private
     */
    _fbTimer() {
        this._timerPointer = setTimeout(() => {
            this._fbTimer();
            if (this._firstFrameReceived && !this._processingFrame && this._fps > 0) {
                this.requestFrameUpdate();
            }
        }, this._timerInterval)
    }

    /**
     * Adjust the configured FPS
     * @param fps {number} - Number of update requests send by second
     */
    changeFps(fps) {
        if (fps && !Number.isNaN(fps)) {
            this._fps = Number(fps);
            this._timerInterval = this._fps > 0 ? 1000 / this._fps : 0;

            if (this._timerPointer && !this._fps) {
                // If FPS was zeroed stop the timer
                clearTimeout(this._timerPointer);
                this._timerPointer = null;
            } else if (this._fps && !this._timerPointer) {
                // If FPS was zero and is now set, start the timer
                this._fbTimer();
            }

        } else {
            throw new Error('Invalid FPS. Must be a number.');
        }
    }

    /**
     * Starts the connection with the VNC server
     * @param options
     */
    connect(options = {
        host: '',
        password: '',
        set8BitColor: false,
        port: 5900
    }) {

        if (!options.host) {
            throw new Error('Host missing.');
        }

        if (options.password) {
            this._password = options.password;
        }

        this._set8BitColor = options.set8BitColor || false;

        this._connection = net.connect(options.port || 5900, options.host);

        this._connection.on('connect', () => {
            this._connected = true;
            this.emit('connected');
        });

        this._connection.on('close', () => {
            this.resetState();
            this.emit('closed');
        });

        this._connection.on('timeout', () => {
            this.emit('connectTimeout');
        });

        this._connection.on('error', (err) => {
            this.emit('connectError', err);
        })

        this._connection.on('data', async (data) => {

            this._log(data.toString(), true, 5);
            this._socketBuffer.pushData(data);

            if (this._processingFrame) {
                return;
            }

            if (!this._handshaked) {
                this._handleHandshake();
            } else if (this._expectingChallenge) {
                await this._handleAuthChallenge();
            } else if (this._waitingServerInit) {
                await this._handleServerInit();
            } else {
                await this._handleData();
            }

        });

    }

    /**
     * Disconnect the client
     */
    disconnect() {
        if (this._connection) {
            this._connection.end();
            this.resetState();
            this.emit('disconnected');
        }
    }

    /**
     * Request the server a frame update
     * @param full - If the server should send all the frame buffer or just the last changes
     * @param incremental - Incremental number for not full requests
     * @param x - X position of the update area desired, usually 0
     * @param y - Y position of the update area desired, usually 0
     * @param width - Width of the update area desired, usually client width
     * @param height - Height of the update area desired, usually client height
     */
    requestFrameUpdate(full = false, incremental = 1, x = 0, y = 0, width = this.clientWidth, height = this.clientHeight) {
        if ((this._frameBufferReady || full) && this._connection && !this._rects && this._encodingsSent && !this._requestSent) {

            this._requestSent = true;
            this._log('Requesting frame update.', true, 3);

            // Request data
            const message = new Buffer(10);
            message.writeUInt8(3); // Message type
            message.writeUInt8(full ? 0 : incremental, 1); // Incremental
            message.writeUInt16BE(x, 2); // X-Position
            message.writeUInt16BE(y, 4); // Y-Position
            message.writeUInt16BE(width, 6); // Width
            message.writeUInt16BE(height, 8); // Height

            this.sendData(message);

            this._frameBufferReady = true;

        }
    }

    /**
     * Handle handshake msg
     * @private
     */
    _handleHandshake() {
        // Handshake, negotiating protocol version
        this._log('Received: ' + this._socketBuffer.toString(), true, 2);
        this._log(this._socketBuffer.buffer, true, 3);
        if (this._socketBuffer.toString() === versionString.V3_003) {
            this._log('Sending 3.3', true);
            this.sendData(versionString.V3_003);
            this._version = '3.3';
        } else if (this._socketBuffer.toString() === versionString.V3_007) {
            this._log('Sending 3.7', true);
            this.sendData(versionString.V3_007);
            this._version = '3.7';
        } else if (this._socketBuffer.toString() === versionString.V3_008) {
            this._log('Sending 3.8', true);
            this.sendData(versionString.V3_008);
            this._version = '3.8';
        } else {
            // Negotiating auth mechanism
            this._handshaked = true;
            if (this._socketBuffer.includes(0x02) && this._password) {
                this._log('Password provided and server support VNC auth. Choosing VNC auth.', true);
                this._expectingChallenge = true;
                this.sendData(new Buffer.from([0x02]));
            } else if (this._socketBuffer.includes(1)) {
                this._log('Password not provided or server does not support VNC auth. Trying none.', true);
                this.sendData(new Buffer.from([0x01]));
                if (this._version === '3.7') {
                    this._sendClientInit();
                } else {
                    this._expectingChallenge = true;
                    this._challengeResponseSent = true;
                }
            } else {
                this._log('Connection error. Msg: ' + this._socketBuffer.toString());
                this.disconnect();
            }
        }

    }

    /**
     * Send data to the server
     * @param data
     * @param flush - If true, flush the local buffer before sending
     */
    sendData(data, flush = true) {
        if (flush) {
            this._socketBuffer.flush(false);
        }
        this._connection.write(data);
    }

    /**
     * Handle VNC auth challenge
     * @private
     */
    async _handleAuthChallenge() {

        if (this._challengeResponseSent) {
            // Challenge response already sent. Checking result.

            if (this._socketBuffer.readUInt32BE() === 0) {
                // Auth success
                this._log('Authenticated successfully', true);
                this._authenticated = true;
                this.emit('authenticated');
                this._expectingChallenge = false;
                this._sendClientInit();
            } else {
                // Auth fail
                this._log('Authentication failed', true);
                this.emit('authError');
                this.resetState();
            }

        } else {

            this._log('Challenge received.', true);
            await this._socketBuffer.waitBytes(16, 'Auth challenge');

            const key = new Buffer(8);
            key.fill(0);
            key.write(this._password.slice(0, 8));

            this.reverseBits(key);

            const des1 = crypto.createCipheriv('des', key, new Buffer(8));
            const des2 = crypto.createCipheriv('des', key, new Buffer(8));

            const response = new Buffer(16);

            response.fill(des1.update(this._socketBuffer.buffer.slice(0, 8)), 0, 8);
            response.fill(des2.update(this._socketBuffer.buffer.slice(8, 16)), 8, 16);

            this._log('Sending response: ' + response.toString(), true, 2);

            this.sendData(response);
            this._challengeResponseSent = true;

        }

    }

    /**
     * Reverse bits order of a byte
     * @param buf - Buffer to be flipped
     */
    reverseBits(buf) {
        for (let x = 0; x < buf.length; x++) {
            let newByte = 0;
            newByte += buf[x] & 128 ? 1 : 0;
            newByte += buf[x] & 64 ? 2 : 0;
            newByte += buf[x] & 32 ? 4 : 0;
            newByte += buf[x] & 16 ? 8 : 0;
            newByte += buf[x] & 8 ? 16 : 0;
            newByte += buf[x] & 4 ? 32 : 0;
            newByte += buf[x] & 2 ? 64 : 0;
            newByte += buf[x] & 1 ? 128 : 0;
            buf[x] = newByte;
        }
    }

    /**
     * Handle server init msg
     * @returns {Promise<void>}
     * @private
     */
    async _handleServerInit() {

        this._waitingServerInit = false;

        await this._socketBuffer.waitBytes(24, 'Server init');

        this.clientWidth = this._socketBuffer.readUInt16BE();
        this.clientHeight = this._socketBuffer.readUInt16BE();
        this.pixelFormat.bitsPerPixel = this._socketBuffer.readUInt8();
        this.pixelFormat.depth = this._socketBuffer.readUInt8();
        this.pixelFormat.bigEndianFlag = this._socketBuffer.readUInt8();
        this.pixelFormat.trueColorFlag = this._socketBuffer.readUInt8();
        this.pixelFormat.redMax = this.bigEndianFlag ? this._socketBuffer.readUInt16BE() : this._socketBuffer.readUInt16LE();
        this.pixelFormat.greenMax = this.bigEndianFlag ? this._socketBuffer.readUInt16BE() : this._socketBuffer.readUInt16LE();
        this.pixelFormat.blueMax = this.bigEndianFlag ? this._socketBuffer.readUInt16BE() : this._socketBuffer.readUInt16LE();
        this.pixelFormat.redShift = this._socketBuffer.readInt8() / 8;
        this.pixelFormat.greenShift = this._socketBuffer.readInt8() / 8;
        this.pixelFormat.blueShift = this._socketBuffer.readInt8() / 8;
        // Padding
        this._socketBuffer.offset += 3;
        this.updateFbSize();
        const nameSize = this._socketBuffer.readUInt32BE();
        await this._socketBuffer.waitBytes(nameSize, 'Name Size');
        this.clientName = this._socketBuffer.readNBytesOffset(nameSize).toString();

        this._log(`Screen size: ${this.clientWidth}x${this.clientHeight}`);
        this._log(`Client name: ${this.clientName}`);
        this._log(`pixelFormat: ${JSON.stringify(this.pixelFormat)}`);

        if (this._set8BitColor) {
            this._log(`8 bit color format requested, only raw encoding is supported.`);
            this._setPixelFormatToColorMap();
        }

        this._sendEncodings();

        setTimeout(() => {
            this.requestFrameUpdate(true);
        }, 1000);

    }

    /**
     * Update the frame buffer size according to client width and height (RGBA)
     */
    updateFbSize() {
        this._log(`Updating the frame buffer size.`, true);
        this.fb = new Buffer(this.clientWidth * this.clientHeight * 4);
    }

    /**
     * Request the server to change to 8bit color format (Color palette). Only works with Raw encoding.
     * @private
     */
    _setPixelFormatToColorMap() {

        this._log(`Requesting PixelFormat change to ColorMap (8 bits).`);

        const message = new Buffer(20);
        message.writeUInt8(0); // Tipo da mensagem
        message.writeUInt8(0, 1); // Padding
        message.writeUInt8(0, 2); // Padding
        message.writeUInt8(0, 3); // Padding

        message.writeUInt8(8, 4); // PixelFormat - BitsPerPixel
        message.writeUInt8(8, 5); // PixelFormat - Depth
        message.writeUInt8(0, 6); // PixelFormat - BigEndianFlag
        message.writeUInt8(0, 7); // PixelFormat - TrueColorFlag
        message.writeUInt16BE(255, 8); // PixelFormat - RedMax
        message.writeUInt16BE(255, 10); // PixelFormat - GreenMax
        message.writeUInt16BE(255, 12); // PixelFormat - BlueMax
        message.writeUInt8(0, 14); // PixelFormat - RedShift
        message.writeUInt8(8, 15); // PixelFormat - GreenShift
        message.writeUInt8(16, 16); // PixelFormat - BlueShift
        message.writeUInt8(0, 17); // PixelFormat - Padding
        message.writeUInt8(0, 18); // PixelFormat - Padding
        message.writeUInt8(0, 19); // PixelFormat - Padding

        // Send a request to change pixelFormat to colorMap
        this.sendData(message);

        this.pixelFormat.bitsPerPixel = 8;
        this.pixelFormat.depth = 8;

    }

    /**
     * Send supported encodings
     * @private
     */
    _sendEncodings() {

        this._log('Sending encodings.');
        this._encodingsSent = true;
        // If this._set8BitColor is set, only copyrect and raw encodings are supported
        const message = new Buffer(4 + ((!this._set8BitColor ? this.encodings.length : 2) * 4));
        message.writeUInt8(2); // Message type
        message.writeUInt8(0, 1); // Padding
        message.writeUInt16BE(!this._set8BitColor ? this.encodings.length : 2, 2); // Padding

        let offset = 4;
        // If 8bits is not set, send all encodings configured
        if (!this._set8BitColor) {
            for (const e of this.encodings) {
                message.writeInt32BE(e, offset);
                offset += 4;
            }
        } else {
            // Only those encodings are supported with 8bits color
            message.writeInt32BE(encodings.copyRect, offset);
            message.writeInt32BE(encodings.raw, offset + 4);
        }

        this.sendData(message);

    }

    /**
     * Send client init msg
     * @private
     */
    _sendClientInit() {
        this._log(`Sending clientInit`);
        this._waitingServerInit = true;
        // Shared bit set
        this.sendData(new Buffer.from([1]));
    }

    /**
     * Handle data msg
     * @returns {Promise<void>}
     * @private
     */
    async _handleData() {

        if (!this._rects) {
            switch (this._socketBuffer.buffer[0]) {
                case serverMsgTypes.fbUpdate:
                    await this._handleFbUpdate();
                    break;

                case serverMsgTypes.setColorMap:
                    await this._handleSetColorMap();
                    break;

                case serverMsgTypes.bell:
                    this.emit('bell');
                    this._socketBuffer.flush();
                    break;

                case serverMsgTypes.cutText:
                    await this._handleCutText();
                    break;
            }
        }

    }

    /**
     * Cut message (text was copied to clipboard on server)
     * @returns {Promise<void>}
     * @private
     */
    async _handleCutText() {
        this._socketBuffer.setOffset(4);
        await this._socketBuffer.waitBytes(1, 'Cut text size');
        const length = this._socketBuffer.readUInt32BE();
        await this._socketBuffer.waitBytes(length, 'Cut text data');
        this.emit('cutText', this._socketBuffer.readNBytesOffset(length).toString());
        this._socketBuffer.flush();
    }

    /**
     * Handle a rects of update message
     */
    async _handleRect() {

        const sendFbUpdate = this._rects;
        this._processingFrame = true;

        while (this._rects) {

            await this._socketBuffer.waitBytes(12, 'Rect begin');
            const rect = {};
            rect.x = this._socketBuffer.readUInt16BE();
            rect.y = this._socketBuffer.readUInt16BE();
            rect.width = this._socketBuffer.readUInt16BE();
            rect.height = this._socketBuffer.readUInt16BE();
            rect.encoding = this._socketBuffer.readInt32BE();

            this._log(`Rect data. X: ${rect.x}  Y: ${rect.y}  W: ${rect.width}  H: ${rect.height}  Encoding: ${rect.encoding}`, true, 2);

            if (rect.encoding === encodings.pseudoCursor) {
                const dataSize = rect.width * rect.height * (this.pixelFormat.bitsPerPixel / 8);
                const bitmaskSize = Math.floor((rect.width + 7) / 8) * rect.height;
                this._cursor.width = rect.width;
                this._cursor.height = rect.height;
                this._cursor.x = rect.x;
                this._cursor.y = rect.y;
                this._cursor.cursorPixels = this._socketBuffer.readNBytesOffset(dataSize);
                this._cursor.bitmask = this._socketBuffer.readNBytesOffset(bitmaskSize);
                rect.data = Buffer.concat([this._cursor.cursorPixels, this._cursor.bitmask]);
            } else if (rect.encoding === encodings.pseudoDesktopSize) {
                this._log('Frame Buffer size change requested by the server', true);
                this.clientHeight = rect.height;
                this.clientWidth = rect.width;
                this.updateFbSize();
                this.emit('desktopSizeChanged', {width: this.clientWidth, height: this.clientHeight});
            } else if (this._decoders[rect.encoding]) {
                await this._decoders[rect.encoding].decode(rect, this.fb, this.pixelFormat.bitsPerPixel, this._colorMap, this.clientWidth, this.clientHeight, this._socketBuffer, this.pixelFormat.depth, this.pixelFormat.redShift, this.pixelFormat.greenShift, this.pixelFormat.blueShift);
            } else {
                this._log('Non supported update received. Encoding: ' + rect.encoding);
            }
            this._rects--;
            this.emit('rectProcessed', rect);
            //
            // if (!this._rects) {
            //     this._socketBuffer.flush(true);
            // }

        }

        if (sendFbUpdate) {
            if (!this._firstFrameReceived) {
                this._firstFrameReceived = true;
                this.emit('firstFrameUpdate', this.fb);
            }
            this._log('Frame buffer updated.', true, 2);
            this.emit('frameUpdated', this.fb);
        }

        this._processingFrame = false;

        if (this._fps === 0) {
            // If FPS is not set, request a new update as soon as the last received has been processed
            this.requestFrameUpdate();
        }

    }

    async _handleFbUpdate() {

        this._socketBuffer.setOffset(2);
        this._rects = this._socketBuffer.readUInt16BE();
        this._log('Frame update received. Rects: ' + this._rects, true);
        await this._handleRect();
        this._requestSent = false;

    }

    /**
     * Handle setColorMap msg
     * @returns {Promise<void>}
     * @private
     */
    async _handleSetColorMap() {

        this._socketBuffer.setOffset(2);
        let firstColor = this._socketBuffer.readUInt16BE();
        const numColors = this._socketBuffer.readUInt16BE();

        this._log(`ColorMap received. Colors: ${numColors}.`);

        await this._socketBuffer.waitBytes(numColors * 6, 'Colormap data');

        for (let x = 0; x < numColors; x++) {
            this._colorMap[firstColor] = this._socketBuffer.readRgbColorMap(this.pixelFormat.redShift, this.pixelFormat.greenShift, this.pixelFormat.blueShift, this.pixelFormat.redMax, this.pixelFormat.greenMax, this.pixelFormat.blueMax);
            firstColor++;
        }

        this.emit('colorMapUpdated', this._colorMap);
        this._socketBuffer.flush();

    }

    /**
     * Reset the class state
     */
    resetState() {

        if (this._connection) {
            this._connection.end();
        }

        if (this._timerPointer) {
            clearInterval(this._timerPointer);
        }

        this._timerPointer = null;

        this._connection = null;

        this._connected = false;
        this._authenticated = false;
        this._version = '';

        this._password = '';

        this._handshaked = false;

        this._expectingChallenge = false;
        this._challengeResponseSent = false;

        this._frameBufferReady = false;
        this._firstFrameReceived = false;
        this._processingFrame = false;

        this._requestSent = false;

        this._encodingsSent = false;

        this.clientWidth = 0;
        this.clientHeight = 0;
        this.clientName = '';

        this.pixelFormat = {
            bitsPerPixel: 0,
            depth: 0,
            bigEndianFlag: 0,
            trueColorFlag: 0,
            redMax: 0,
            greenMax: 0,
            blueMax: 0,
            redShift: 0,
            blueShift: 0,
            greenShift: 0
        }

        this._rects = 0

        this._colorMap = [];
        this.fb = null;

        this._socketBuffer?.flush(false);

        this._cursor = {
            width: 0,
            height: 0,
            x: 0,
            y: 0,
            cursorPixels: null,
            bitmask: null
        }

    }

    /**
     * Send a key event
     * @param key - Key code (keysym) defined by X Window System, check https://wiki.linuxquestions.org/wiki/List_of_keysyms
     * @param down - True if the key is pressed, false if it is not
     */
    sendKeyEvent(key, down = false) {

        const message = new Buffer(8);
        message.writeUInt8(4); // Message type
        message.writeUInt8(down ? 1 : 0, 1); // Down flag
        message.writeUInt8(0, 2); // Padding
        message.writeUInt8(0, 3); // Padding

        message.writeUInt32BE(key, 4); // Key code

        this.sendData(message, false);

    }


    /**
     * Send pointer event (mouse or touch)
     * @param xPosition - X Position
     * @param yPosition - Y Position
     * @param button1 - True for pressed, false for unpressed - Usually left mouse button
     * @param button2 - True for pressed, false for unpressed - Usually middle mouse button
     * @param button3 - True for pressed, false for unpressed - Usually right mouse button
     * @param button4 - True for pressed, false for unpressed - Usually scroll up mouse event
     * @param button5 - True for pressed, false for unpressed - Usually scroll down mouse event
     * @param button6 - True for pressed, false for unpressed
     * @param button7 - True for pressed, false for unpressed
     * @param button8 - True for pressed, false for unpressed
     */
    sendPointerEvent(xPosition, yPosition, button1 = false, button2 = false, button3 = false, button4 = false, button5 = false,
                     button6 = false, button7 = false, button8 = false) {

        let buttonMask = 0;

        buttonMask += button8 ? 128 : 0;
        buttonMask += button7 ? 64 : 0;
        buttonMask += button6 ? 32 : 0;
        buttonMask += button5 ? 16 : 0;
        buttonMask += button4 ? 8 : 0;
        buttonMask += button3 ? 4 : 0;
        buttonMask += button2 ? 2 : 0;
        buttonMask += button1 ? 1 : 0;

        const message = new Buffer(6);
        message.writeUInt8(5); // Message type
        message.writeUInt8(buttonMask, 1); // Button Mask
        message.writeUInt16BE(xPosition, 2); // X Position
        message.writeUInt16BE(yPosition, 4); // Y Position

        this.sendData(message, false);

    }

    /**
     * Send client cut message to server
     * @param text - latin1 encoded
     */
    clientCutText(text) {

        const textBuffer = new Buffer.from(text, 'latin1');
        const message = new Buffer(8 + textBuffer.length);
        message.writeUInt8(6); // Message type
        message.writeUInt8(0, 1); // Padding
        message.writeUInt8(0, 2); // Padding
        message.writeUInt8(0, 3); // Padding
        message.writeUInt32BE(textBuffer.length, 4); // Padding
        textBuffer.copy(message, 8);

        this.sendData(message, false);

    }

    /**
     * Print log info
     * @param text
     * @param debug
     * @param level
     * @private
     */
    _log(text, debug = false, level = 1) {
        if (!debug || (debug && this.debug && level <= this.debugLevel)) {
            console.log(text);
        }
    }

}

exports = module.exports = VncClient;
