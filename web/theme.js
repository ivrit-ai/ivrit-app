// Light or dark: the device's, following it as it changes, unless the user chose
// one in Settings (kept on this device). Set on <html> as data-theme before the
// page draws, so it never flashes the other one; theme.css colours by it.
(function () {
  var KEY = "theme";
  var COLORS = { light: "#F7F6F3", dark: "#111110" };
  var media = matchMedia("(prefers-color-scheme: dark)");

  function chosen() {
    try {
      var value = localStorage.getItem(KEY);
      return value === "light" || value === "dark" ? value : "system";
    } catch (e) {
      return "system";
    }
  }

  function resolved() {
    var choice = chosen();
    return choice === "system" ? (media.matches ? "dark" : "light") : choice;
  }

  function apply() {
    var theme = resolved();
    document.documentElement.dataset.theme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = COLORS[theme];
    dispatchEvent(new CustomEvent("themechange", { detail: theme }));
  }

  self.ivritTheme = {
    chosen: chosen,
    resolved: resolved,
    choose: function (choice) {
      try {
        if (choice === "light" || choice === "dark") localStorage.setItem(KEY, choice);
        else localStorage.removeItem(KEY);
      } catch (e) {}
      apply();
    },
  };

  apply();
  if (media.addEventListener) media.addEventListener("change", apply);
  else if (media.addListener) media.addListener(apply);
})();
