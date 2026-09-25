// Express 4 não encaminha rejeições de Promise para o middleware de erro automaticamente;
// sem isso, um erro dentro de um handler async trava a requisição até o timeout do cliente.
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Erro de negócio com status HTTP (< 500 vai para o cliente com a mensagem; ver app.js).
// "extras" (ex.: { codigo: "CONTAINER_NAO_CADASTRADO" }) vão junto no JSON, para a tela reagir.
export function erroHttp(status, mensagem, extras = null) {
  const erro = new Error(mensagem);
  erro.status = status;
  if (extras) erro.extras = extras;
  return erro;
}
