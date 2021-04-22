<!--
*** Thanks for checking out the Best-README-Template. If you have a suggestion
*** that would make this better, please fork the repo and create a pull request
*** or simply open an issue with the tag "enhancement".
*** Thanks again! Now go create something AMAZING! :D
***
***
***
*** To avoid retyping too much info. Do a search and replace for the following:
*** github_username, repo_name, twitter_handle, email, project_title, project_description
-->


<!-- PROJECT SHIELDS -->
<!--
*** I'm using markdown "reference style" links for readability.
*** Reference links are enclosed in brackets [ ] instead of parentheses ( ).
*** See the bottom of this document for the declaration of the reference variables
*** for contributors-url, forks-url, etc. This is an optional, concise syntax you may use.
*** https://www.markdownguide.org/basic-syntax/#reference-style-links
-->
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]
[![LinkedIn][linkedin-shield]][linkedin-url]



<!-- PROJECT LOGO -->

<h3 align="center">VNC-RFB-CLIENT</h3>

  <p align="center">
    Pure node.js implementation of RFC 6143 (RFB Protocol / VNC) client with no external dependencies. Supports Raw, CopyRect, Hextile and ZRLE encodings.
    <br />
    <a href="https://github.com/github_username/repo_name/issues">Report Bug or Request Feature</a>
  </p>
</p>


<!-- GETTING STARTED -->

## Getting Started

### Requirements

Node.js >= 10

### Installation

1. Install NPM packages
   ```sh
   npm install vnc-rfb-client
   ```

<!-- USAGE EXAMPLES -->

## Usage

```javascript
const VncClient = require('vnc-rfb-client');

const initOptions = {
    debug: false, // Set debug logging
    encodings: [ // Encodings sent to server, in order of preference
        VncClient.consts.encodings.copyRect,
        VncClient.consts.encodings.zrle,
        VncClient.consts.encodings.hextile,
        VncClient.consts.encodings.raw,
        VncClient.consts.encodings.pseudoDesktopSize,
    ]
};
const client = new VncClient(initOptions);

const connectionOptions = {
    host: '', // VNC Server
    password: '', // Password
    set8BitColor: false, // If set to true, client will request 8 bit color, only supported with Raw encoding
    port: 5900 // Remote server port
}
client.connect(connectionOptions);

// Client successfully connected
client.on('connected', () => {
    console.log('Client connected.');
});

// Connection timed out
client.on('connectTimeout', () => {
    console.log('Connection timeout.');
});

// Client successfully authenticated
client.on('authenticated', () => {
    console.log('Client authenticated.');
});

// Authentication error
client.on('authError', () => {
    console.log('Client authentication error.');
});

// Bell received from server
client.on('bell', () => {
    console.log('Bell received');
});

// Client disconnected
client.on('disconnect', () => {
    console.log('Client disconnected.');
    process.exit();
});

// Clipboard event on server
client.on('cutText', (text) => {
    console.log('clipboard text received: ' + text);
});

// Frame buffer updated
client.on('firstFrameUpdate', (fb) => {
   console.log('First Framebuffer update received.');
});

// Frame buffer updated
client.on('frameUpdated', (fb) => {
    console.log('Framebuffer updated.');
});

// Color map updated (8 bit color only)
client.on('colorMapUpdated', (colorMap) => {
    console.log('Color map updated. Colors: ' + colorMap.length);
});

// Rect processed
client.on('rectProcessed', (rect) => {
    console.log('rect processed');
});

```

## Examples

### Save frame to jpg

```javascript
const VncClient = require('vnc-rfb-client');
const jimp = require('jimp');

const client = new VncClient();

// Just 1 update per second
client.changeFps(1);
client.connect({host: '127.0.0.1', port: 5900, password: 'password'});

client.on('frameUpdated', (data) => {
    new Jimp(data, (err, image) => {
        if (err) {
            console.log(err);
        }
        const fileName = `${Date.now()}.jpg`;
        console.log(`Saving frame to file. ${fileName}`);
        image.write(`./${fileName}`);
    });
});

client.on('frameUpdated', (fb) => {
    console.log('Framebuffer updated.');
});

```

### Record session with FFMPEG

```javascript
const VncClient = require('vnc-rfb-client');
const spawn = require('child_process').spawn;
const fps = 10;

let timerRef;
const client = new VncClient({fps});
let out;

client.connect({host: '127.0.0.1', port: 5900, password: 'abc123'});

client.on('firstFrameUpdate', () => {
   console.log('Start recording...');
   out = spawn('C:\\Users\\filip\\Projetos\\vncrecorder\\ffmpeg.exe',
           `-loglevel error -hide_banner -y -f rawvideo -vcodec rawvideo -an -pix_fmt rgba -s ${client.clientWidth}x${client.clientHeight} -r ${fps} -i - -an -r ${fps} -vcodec libx264rgb session.h264`.split(' '));
   timer();
});

process.on('SIGINT', function () {
   console.log("Exiting.");
   close();
});

function timer() {
   timerRef = setTimeout(() => {
      timer();
      out?.stdin?.write(client.fb);
   }, 1000 / fps);
}

function close() {
   if (timerRef) {
      clearTimeout(timerRef);
   }
   if (out) {
      out.kill('SIGINT');
      out.on('exit', () => {
         process.exit(0);
      });
   }
}

client.on('disconnect', () => {
   console.log('Client disconnected.');
   close();
});

```

## Methods

```javascript
/**
 * Request a frame update to the server
 */
client.requestFrameUpdate(full, increment, x, y, width, height);

/**
 * Change the rate limit of frame buffer requests
 * If set to 0, a new update request will be sent as soon as the last update finish processing
 */
client.changeFps(10);

/**
 * Start the connection with the server
 */
const connectionOptions = {
    host: '', // VNC Server
    password: '', // Password
    set8BitColor: false, // If set to true, client will request 8 bit color, only supported with Raw encoding
    port: 5900 // Remote server port
}
client.connect(connectionOptions);

/**
 * Send a key board event
 * Check https://wiki.linuxquestions.org/wiki/List_of_keysyms for keycodes
 * down = true for keydown and down = false for keyup
 */
client.sendKeyEvent(keysym, down);

/**
 * Send pointer event (mouse or touch)
 * xPosition - X Position of the pointer
 * yPosition - Y Position of the pointer
 * button1 to button 8 - True for down, false for up
 */
client.sendPointerEvent(xPosition, yPosition, button1, button2, button3, button4, button5, button6, button7, button8);

/**
 * Send clipboard event to server
 * text - Text copied to clipboard
 */
client.clientCutText(text);

client.resetState(); // Reset the state of the client, clear the frame buffer and purge all data
```

<!-- ROADMAP -->

## Roadmap

### Done

#### Encodings Supported

Raw <br>
CopyRect <br>
Hextile <br>
ZRLE <br>
PseudoDesktopSize <br>
3.7 and 3.8 protocol implementations

### TODO:

Tight Encoding <br>
Pseudo Cursor Encoding <br>
Save session data to file <br>
Replay session from rect data saved to file

## License

Distributed under the MIT License. See `LICENSE` for more information.



<!-- CONTACT -->

## Contact

Filipe Calaça - filipe@habilis.eng.br

Project Link: [https://github.com/filipecalaca/vnc-rfb-client](https://github.com/filipecalaca/vnc-rfb-client)



<!-- MARKDOWN LINKS & IMAGES -->
<!-- https://www.markdownguide.org/basic-syntax/#reference-style-links -->

[contributors-shield]: https://img.shields.io/github/contributors/github_username/repo.svg?style=for-the-badge

[contributors-url]: https://github.com/filipecalaca/vnc-rfb-client/graphs/contributors

[forks-shield]: https://img.shields.io/github/forks/github_username/repo.svg?style=for-the-badge

[forks-url]: https://github.com/filipecalaca/vnc-rfb-client/network/members

[stars-shield]: https://img.shields.io/github/stars/github_username/repo.svg?style=for-the-badge

[stars-url]: https://github.com/filipecalaca/vnc-rfb-client/stargazers

[issues-shield]: https://img.shields.io/github/issues/github_username/repo.svg?style=for-the-badge

[issues-url]: https://github.com/filipecalaca/vnc-rfb-client/issues

[license-shield]: https://img.shields.io/github/license/github_username/repo.svg?style=for-the-badge

[license-url]: https://github.com/filipe/vnc-rfb-client/blob/master/LICENSE.txt

[linkedin-shield]: https://img.shields.io/badge/-LinkedIn-black.svg?style=for-the-badge&logo=linkedin&colorB=555

[linkedin-url]: https://linkedin.com/in/filipecalaca