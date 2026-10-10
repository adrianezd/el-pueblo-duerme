# El pueblo duerme

Juego de fiesta gratuito de deducción social para grupos: lobos contra aldeanos. Se juega en **un solo móvil** que se va pasando (hace de narrador) o **cada uno con su móvil**, entrando en la misma sala con un código. Sin cuentas ni descargas.

🔗 **Jugar ahora:** https://adrianezd.github.io/el-pueblo-duerme/

## Cómo se juega

1. **Reparto.** Cada uno ve en secreto su papel manteniendo pulsada la carta. Los lobos saben quiénes son sus compañeros.
2. **Noche.** Los lobos eligen a quién devorar (la víctima es la más votada por la manada; si empatan, al azar). La vidente descubre si alguien es lobo. La curandera protege a alguien, pero no a la misma persona dos noches seguidas. Los aldeanos también tocan a alguien, para que nadie se delate por el tiempo que tarda.
3. **Amanecer.** Se anuncia quién no ha despertado (y, si está activado, qué papel tenía) o si la curandera salvó a la víctima.
4. **Día.** Debate con cronómetro y votación: se echa al más votado. Si hay empate o gana «Nadie», nadie se va.
5. **Final.** Gana el pueblo si caen todos los lobos. Ganan los lobos si llegan a ser tantos como el resto.

## Papeles

| Papel | Qué hace |
| --- | --- |
| 🐺 **Lobo** | Cada noche, con su manada, elige a quién devorar. |
| 🔮 **Vidente** | Cada noche descubre si un jugador es lobo. |
| 🌿 **Curandera** | Cada noche protege a alguien (también a sí misma); no repite dos noches seguidas. |
| 🧑‍🌾 **Aldeano** | Sin poderes, pero con voto. |

De 4 a 16 jugadores. Lobos sugeridos: 1 hasta 6 jugadores, 2 de 7 a 10 y 3 a partir de 11 (máximo, un tercio).

## Dos modos

- **Mismo móvil:** el móvil se pasa por orden. De noche cada uno toca «Soy …» y hace su acción en secreto. La votación es a mano alzada o secreta pasando el móvil. Funciona sin conexión.
- **Con código de sala:** uno pone su nombre y pulsa **Crear sala** (sale un código de 5 letras y un botón para compartir el enlace); el resto entra con su nombre y el código. Quien crea la sala elige los ajustes y también juega. Cada uno ve su papel, hace su acción de noche y vota en su propio móvil; quien creó la sala va pasando de fase.

Los móviles de una sala se comunican a través de [ntfy.sh](https://ntfy.sh) (servicio gratuito de mensajes, sin cuentas), un canal por sala, sin que los mensajes se guarden en el servidor. En ese modo hace falta internet.

## Privacidad

La partida vive solo en memoria. En `localStorage` solo se guardan los ajustes y los nombres (compartidos con los otros juegos de fiesta).

## Stack técnico

Sitio estático sin dependencias ni build: HTML, CSS y JavaScript vanilla servidos por GitHub Pages.

- `script.js` — el juego: un único motor (`newGame` / `act`) para los dos modos.
- `sala.js` y `sala.css` — modo con código de sala, iguales en los juegos de fiesta (¿Quién es el Impostor?, Dibujo Impostor, El Dato Falso y este). Este juego usa su modo por fases (`custom`).
- `kit.js` — piezas compartidas (nombres, cronómetro, votación, sonido…).
- `sw.js` — caché para jugar sin conexión.

## Aviso

Juego de fiesta **original** de deducción social, no afiliado a ninguna marca, producto o juego comercial.
