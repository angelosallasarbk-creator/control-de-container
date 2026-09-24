// Express 4 não encaminha rejeições de Promise para o middleware de erro automaticamente;
// sem isso, um erro dentro de um handler async trava a requisição até o timeout do cliente.
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Erro de negócio com status HTTP (< 500 vai para o cliente com a mensagem; ver server.js).
export function erroHttp(status, mensagem) {
  const erro = new Error(mensagem);
  erro.status = status;
  return erro;
}
