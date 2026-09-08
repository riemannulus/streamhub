import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node';

const devices = await listStreamDecks();
if (devices.length !== 1) throw new Error(`Expected exactly one Stream Deck, found ${devices.length}`);
const deck = await openStreamDeck(devices[0].path, { resetToLogoOnClose: false });
deck.on('error', error => console.error('HID error:', error));
try {
  await deck.resetToLogo();
  console.log(JSON.stringify({ status: 'default-screen-command-sent', model: deck.MODEL }));
} finally { await deck.close(); }
