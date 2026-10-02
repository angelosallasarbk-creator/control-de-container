// Leitura de posição GPS mais precisa: em vez de aceitar a 1ª leitura (que costuma vir da rede,
// com centenas de metros de erro), acompanha as leituras por alguns segundos e fica com a melhor —
// para assim que chegar uma boa o bastante ("alvoM") ou o tempo acabar.

const leitura = (p) => ({ latitude: p.coords.latitude, longitude: p.coords.longitude, precisaoM: Math.round(p.coords.accuracy) });

/**
 * Resolve com { latitude, longitude, precisaoM } (a leitura mais precisa obtida) ou rejeita com
 * { code } (1 = permissão negada, 2 = sem sinal, 3 = tempo esgotado sem nenhuma leitura).
 */
export function melhorPosicao({ alvoM = 30, tempoMaxMs = 15000, maximumAge = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let melhor = null;
    let terminado = false;
    let id = null;
    let ultimoErro = { code: 3 };
    const fim = (erro) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(timer);
      if (id !== null) navigator.geolocation.clearWatch(id);
      if (melhor) resolve(melhor);
      else reject(erro ?? ultimoErro);
    };
    const timer = setTimeout(() => fim(), tempoMaxMs);
    id = navigator.geolocation.watchPosition(
      (p) => {
        const l = leitura(p);
        if (!melhor || l.precisaoM < melhor.precisaoM) melhor = l;
        if (melhor.precisaoM <= alvoM) fim();
      },
      (e) => {
        // Permissão negada encerra na hora; sem sinal/tempo esgotado: continua tentando até o fim.
        if (e.code === 1) fim({ code: 1 });
        else ultimoErro = { code: e.code };
      },
      { enableHighAccuracy: true, maximumAge, timeout: tempoMaxMs }
    );
    if (terminado && id !== null) navigator.geolocation.clearWatch(id);
  });
}

