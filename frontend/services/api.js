(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});

  App.Api = {
    login: (...args) => App.MockApi.login(...args),
    prepareSearch: (...args) => App.MockApi.prepareSearch(...args),
    search: (...args) => App.MockApi.search(...args),
    sendPersonaMessage: (...args) => App.MockApi.sendPersonaMessage(...args)
  };
})();
