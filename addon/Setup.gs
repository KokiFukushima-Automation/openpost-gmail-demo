/**
 * openpost Gmail add-on - one-time setup (docs/09_phase5_spec.md §6.3, §6.6).
 *
 * Run `setup(baseUrl, token)` once from the Apps Script editor (Run > setup), then
 * `Deploy > Test deployments > Install`. `installLinker()` wires up the optional 5-minute
 * sent-mail poller (Linker.gs); skip it if you never grant the gmail.readonly scope (§6.3 - the
 * add-on works without it, minus reply detection and thread linking, until the reaper marks the
 * draft abandoned).
 */

function setup(baseUrl, token) {
  if (!baseUrl || !/^https:\/\//.test(baseUrl)) {
    throw new Error('setup(baseUrl, token): baseUrl must be an https:// URL reachable from Google\'s servers (UrlFetchApp calls come from Google, not from your phone - a loopback-only instance cannot work here).');
  }
  if (!token) {
    throw new Error('setup(baseUrl, token): token must be your openpost API_TOKEN.');
  }
  var props = PropertiesService.getUserProperties();
  props.setProperty('OPENPOST_BASE_URL', baseUrl.replace(/\/+$/, ''));
  props.setProperty('OPENPOST_TOKEN', token);
  Logger.log('openpost add-on configured for ' + baseUrl);
}

function installLinker() {
  teardownLinkerTriggers_();
  ScriptApp.newTrigger('linkSentMessages').timeBased().everyMinutes(5).create();
  Logger.log('linker installed (runs every 5 minutes)');
}

function teardownLinkerTriggers_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'linkSentMessages') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function teardown() {
  teardownLinkerTriggers_();
  var props = PropertiesService.getUserProperties();
  props.deleteProperty('OPENPOST_BASE_URL');
  props.deleteProperty('OPENPOST_TOKEN');
  Logger.log('openpost add-on configuration removed');
}

/** Run after entering OPENPOST_BASE_URL and OPENPOST_TOKEN in Script properties. */
function configureFromScriptProperties() {
  var settings = PropertiesService.getScriptProperties();
  setup(settings.getProperty('OPENPOST_BASE_URL'), settings.getProperty('OPENPOST_TOKEN'));
  installLinker();
}
