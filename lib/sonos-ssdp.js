'use strict';
const dgram = require('dgram');
const EventEmitter = require('events').EventEmitter;
const util = require('util');
var Promise = require('bluebird');
let logger = require('./logger');

function SSDP(settings) {
  logger = settings.log || logger.initialize();

  const SONOS_PLAYER_UPNP_URN = 'urn:schemas-upnp-org:device:ZonePlayer:1';
  const PLAYER_SEARCH = new Buffer(['M-SEARCH * HTTP/1.1',
    'HOST: 239.255.255.250:reservedSSDPport',
    'MAN: ssdp:discover',
    'MX: 1',
    'ST: ' + SONOS_PLAYER_UPNP_URN].join('\r\n'));

  let socket;
  let _this = this;
  let scanTimeout;
  let socketCycleInterval;

  const localEndpoints = ['0.0.0.0'];
  let endpointIndex = 0;
  let openRequests = 0;

  function extractUUIDFromUSN(usn) {
    let uuidMatch = usn.match(/uuid:([A-Z0-9_]*)/);

    if (uuidMatch) {
      return uuidMatch[1];
    }
  }

  function receiveHandler(buffer, rinfo) {

    var response = buffer.toString('ascii');

    if (response.indexOf(SONOS_PLAYER_UPNP_URN) === -1) {
      // Ignore false positive from badly-behaved non-Sonos device.
      return;
    }

    var headerCollection = response.split('\r\n');
    var headers = {};

    for (var i = 0; i < headerCollection.length; i++) {
      var headerRow = headerCollection[i];

      if (/^([^:]+): (.+)/i.test(headerRow)) {
        headers[RegExp.$1] = RegExp.$2;
      }
    }

    if (!headers.LOCATION) return;

    _this.emit('found', {
      household: headers['X-RINCON-HOUSEHOLD'],
      location: headers.LOCATION,
      uuid: extractUUIDFromUSN(headers.USN),
      ip: rinfo.address
    });
  }

  function sendScan() {
    socket.send(PLAYER_SEARCH, 0, PLAYER_SEARCH.length, 1900, '239.255.255.250');
    scanTimeout = setTimeout(sendScan, 1000);
  }

  function start() {
    createSocket(() => {
      sendScan();
    });

    socketCycleInterval = setInterval(() => {
      createSocket();
    }, 5000);
  }

  function createSocket(callback) {
    if (socket) {
      socket.close();
    }

    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true }, receiveHandler);
    const endpoint = localEndpoints[endpointIndex];
    socket.bind(1905, endpoint, () => {
      socket.setMulticastTTL(2);
      if (callback instanceof Function) {
        callback();
      }
    });
  }

  function stop() {
    if (!socket) return;
    clearInterval(socketCycleInterval);
    clearTimeout(scanTimeout);
    socket.close();
    socket = null;
  }

  /**
   * targeting a player: {player: 'uuidSring'};
   * targeting a household: {household: 'householdString'};
   * @param [target] object specifying optional filtering of player
   */
  function discoverPlayer(target) {
    return new Promise(function(resolve, reject) {
      target = target || {};
      let sonosFoundCallback;
      let sonosSearchErrorCallback;

      let removeListeners = function() {
        _this.removeListener('found', sonosFoundCallback);
        _this.removeListener('error', sonosSearchErrorCallback);
      };

      sonosFoundCallback = function(info) {
        let isNotTheTargetPlayer = target.player && info.uuid !== target.player;
        let isNotTheTargetHousehold = target.household && info.household !== target.household;

        if (isNotTheTargetPlayer || isNotTheTargetHousehold) {
          // Keep searching
          return;
        }

        openRequests--;
        if (openRequests === 0) {
          stop();
        }

        removeListeners();
        resolve(info);
      };

      sonosSearchErrorCallback = function(error) {
        removeListeners();
        reject(error);
      };

      _this.on('found', sonosFoundCallback);
      _this.on('error', sonosSearchErrorCallback);

      if (openRequests === 0) {
        start();
        openRequests++;
      }
    });
  }

  this.start = start;
  this.stop = stop;
  this.discoverPlayer = discoverPlayer;
}

util.inherits(SSDP, EventEmitter);

module.exports = SSDP;
