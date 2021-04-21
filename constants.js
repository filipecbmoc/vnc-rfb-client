// based on https://github.com/sidorares/node-rfb2

const consts = {
    clientMsgTypes: {
        setPixelFormat: 0,
        setEncodings: 2,
        fbUpdate: 3,
        keyEvent: 4,
        pointerEvent: 5,
        cutText: 6,
    },
    serverMsgTypes: {
        fbUpdate: 0,
        setColorMap: 1,
        bell: 2,
        cutText: 3,
    },
    versionString: {
        V3_003: 'RFB 003.003\n',
        V3_007: 'RFB 003.007\n',
        V3_008: 'RFB 003.008\n'
    },
    encodings: {
        raw: 0,
        copyRect: 1,
        rre: 2,
        corre: 4,
        hextile: 5,
        zlib: 6,
        tight: 7,
        zlibhex: 8,
        trle: 15,
        zrle: 16,
        h264: 50,
        pseudoCursor: -239,
        pseudoDesktopSize: -223,
    },
    security: {
        None: 1,
        VNC: 2
    }
}

module.exports = consts;
