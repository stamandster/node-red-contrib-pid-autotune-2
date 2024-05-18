const autoTuner = require("./core/pid-autotuner");

module.exports = function (RED) {
  "use strict";

  function PidAutotune(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    const RUNNING_EVENT_NAME = "AUTOTUNER_RUNNING";
    const COMPLETED_EVENT_NAME = "AUTOTUNER_COMPLETED";

    node.sampleTime = 5; // was 5 should this be adjustable? to look for amplitude after heating
    node.waitTime = 10; // was 5, should this be adjustable? between heating cycles
//	node.sampleTime = config.sampleTime || 5; // was 5 should this be adjustable? to look for amplitude after heating
//  node.waitTime = config.waitTime || 10; // was 5, should this be adjustable? between heating cycles
    node.outputstep = config.outstep || 100;
    node.outmin = config.minout || 0 ; // new node
    node.outmax = config.maxout || 100;
    node.lookbackSec = config.lookback || 60; // was 30
    node.noiseband = config.noiseband || 3; // was 0.5
    node.nextRun = config.nextRun || sleep;

    node.tempVariable = config.tempVariable || "payload";
    node.tempVariableType = config.tempVariableType || "msg";
    node.tempVariableMsgTopic = config.tempVariableMsgTopic || "temp-BK";

    node.autoStart = config.autoStart || "true";
    node.triggeredStartValue = config.triggeredStartValue|| "start"

    node.isRunning = false;

    node.latestTempReading = -1;

    node.stopSignaled = false;

    function log(text) {
      var log = getLogText(text);
      node.send([null, null, { payload: log }]);
    }

    function getLogText(text) {
      var formattedDate = new Date(Date.now()).toISOString();
      return `${formattedDate} - ${text}`;
    }

    function sleep(sec, callback) {
      setTimeout(callback, sec * 1000);
    }

    function getSetpoint(msg) {
      return new Promise(function (resolve) {
        if (config.setpointType === "num") {
          resolve(config.setpoint);
        } else if (config.setpointType === "msg") {
          resolve(msg[config.setpoint]);
        } else {
          RED.util.evaluateNodeProperty(
            config.setpoint,
            config.setpointType,
            node,
            msg,
            (err, value) => {
              if (err) {
                resolve("");
              } else {
                resolve(value);
              }
            }
          );
        }
      });
    }

    function getCurrentTemp() {
      return new Promise(function (resolve, reject) {
        if (node.tempVariableType === "msg") {
          node.latestTempReading > -1
            ? resolve(node.latestTempReading)
            : reject("ERRTEMP01: No temperature reading found");
        } else {
          RED.util.evaluateNodeProperty(
            config.tempVariable,
            config.tempVariableType,
            node,
            {},
            (err, value) => {
              if (err) {
                reject("ERRTEMP02: No temperature reading found");
              } else {
                resolve(value);
              }
            }
          );
        }
      });
    }

    async function runAutoTuner() {
      var completed = autoTuner.run(await getCurrentTemp());
      if (completed) {
        node.emit(COMPLETED_EVENT_NAME, {
          state: autoTuner.state,
          params: autoTuner.getPIDParameters(),
        });
        return;
      }

      if (node.stopSignaled) {
        node.emit(COMPLETED_EVENT_NAME, {
          state: 'Completed',
          params: { Kp: 0, Ki: 0, Kd: 0},
        });
        return;
      }

      const heat_percent = autoTuner.output;
      const heating_time = (node.sampleTime * heat_percent) / 100;
      const waitTime = node.sampleTime - heating_time;
      if (heating_time === node.sampleTime) {
        node.emit(RUNNING_EVENT_NAME, heat_percent);
        node.nextRun(heating_time, runAutoTuner);
      } else if (waitTime === node.sampleTime) {
        node.emit(RUNNING_EVENT_NAME, 0);
        node.nextRun(waitTime, runAutoTuner);
      } else {
        node.emit(RUNNING_EVENT_NAME, heat_percent);
        node.nextRun(heating_time, function() {
          node.emit(RUNNING_EVENT_NAME, 0);
          node.nextRun(waitTime, runAutoTuner);
        });
      }
    }

    async function startAutoTune(msg) {
      log("Autotune Started ...");
      const setpoint = await getSetpoint(msg);
      autoTuner.init({
        setpoint: setpoint,
        outputstep: node.outputstep,
        sampleTimeSec: node.sampleTime,
        lookbackSec: node.lookbackSec,
        outputMin: node.outmin,
        outputMax: node.outmax,
        logFn: log,
      });

      runAutoTuner();
    }

    node.on(RUNNING_EVENT_NAME, function (output) {
      node.send([null, { payload: output }, null]);
    });

    node.on(COMPLETED_EVENT_NAME, function (result) {
      node.isRunning = false;
      node.stopSignaled = false;
      node.send([
        { state: result.state, payload: result.params },
        { payload: 0 },
        { payload: getLogText("... Autotune Completed") },
      ]);
    });

    node.on("input", function (msg, send, done) {
      try {
        if (msg.topic === node.tempVariableMsgTopic) {
          node.latestTempReading = msg.payload;
        }

        if (node.isRunning === false && 
          (node.autoStart === "true" || (node.autoStart === "false" && msg.cmd === node.triggeredStartValue))) {
          startAutoTune(msg);
          node.isRunning = true;
        }

        if (msg.cmd && msg.cmd === "stop") {
          node.stopSignaled = true;
        }

        if (done) done();
      } catch (error) {
        if (done) done(error.message || "ERR001: Unknown Error");
      }
    });
  }

  RED.nodes.registerType("pid-autotune2", PidAutotune);
};
