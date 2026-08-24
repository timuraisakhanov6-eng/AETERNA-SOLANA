import { Wallet } from 'ethers';

const challenge = 'challenge-valid';
const message = `AETERNA identity challenge:${challenge}`;
const wallet = Wallet.createRandom();

const signature = await wallet.signMessage(message);
console.log('account=' + wallet.address);
console.log('message=' + message);
console.log('signature=' + signature);
