/**
 * dsh-infinite-context client half: the styled "/" menu row for /compact-force.
 *
 * The web "/" menu restyles built-in host commands only (HOST_FACES), leaving
 * plugin host rows as a bare name + description with no icon, and a client
 * contribution sharing a host command's name fails loud at candidate
 * synthesis. The host half (src/command-compact-force.ts) therefore hides the
 * raw row from commands.list(); this half contributes the styled row (icon +
 * localized label + description), and its ActionSpec dispatches the fold
 * through the unchanged host command via ctx.remote.commands.execute — the
 * conversation's command/run + command/done events still render the outcome.
 *
 * Shipped as a hand-written ModuleLoader factory (the shape community client
 * halves bundle into, e.g. dshmarket): id is the package name, and the page's
 * module table resolves the bare require below. Declared in package.json via
 * `dsh.client` + exports["./client"].
 */
window.__ModuleLoader__.load({ id: "dsh-infinite-context", factory: (require) => {

  var module = { exports: {} };
  var exports = module.exports;

  var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
  var ForceIcon = primitives.IconLightOutlineRegular
    || primitives.IconRefreshOutlineRegular
    || primitives.IconCompactOutlineRegular;

  // Cordis-level service keys (mirrors ui-commands' own inject face; 'remote'
  // plus the nested 'remote.commands' the composer types require).
  var inject = ["commandUi", "remote", "remote.commands"];

  /**
   * Contribute the /compact-force row for this client's lifetime.
   * @param ctx - client root context.
   */
  function apply(ctx) {
    ctx.effect(function () {
      var contribution = {
        name: "compact-force",
        label: function () { return "强制压缩"; },
        description: function () { return "立即执行一次插件折叠（分段管线，满窗可用）"; },
        icon: ForceIcon,
        available: function () { return true; },
        ui: {
          kind: "action",
          run: function (session) {
            ctx.remote.commands.execute(session.sessionId, "/compact-force", []).then(function (execution) {
              if (execution === undefined) {
                console.warn("dsh-infinite-context: /compact-force is not registered host-side (is the plugin active?)");
                return;
              }
              if (execution.result && execution.result.kind === "error") {
                console.error("/compact-force:", execution.result.text);
              }
            }, function (error) {
              console.error("/compact-force dispatch failed:", error);
            });
          },
        },
      };
      return ctx.commandUi.register(contribution);
    }, "dsh-infinite-context: /compact-force menu row");
  }

  exports.name = "command-compact-force-client";
  exports.inject = inject;
  exports.apply = apply;
  return module.exports;
}});
