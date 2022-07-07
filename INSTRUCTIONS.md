# Setup Instructions

#### 0. Clone this repository somewhere.
- Run `git clone https://github.com/wdingocoin/wdingocoin.git wdingocoin`. This creates a `wdingocoin` folder containing the files necessary for running the authority node.
- Make sure it is cloned, and not just downloaded. We need the .git metadata for version tracking.

#### 1. Add Change address to dingo wallet:
- Ensure Dingo daemon is running: `dingocoind`.
- Run `dingocoin-cli createmultisig 3 "[\"034db16180d9c603c54a29a481362d975f06fc78298d10ac7c5b8ce4c0400b6093\", \"03c0ef9df24b3ab410b615aaf8c8aa8257e2686b48d6643f0a8f58434dced9ea33\", \"0324e074121a598f21ab73f0a9807a89c72e39a10c84d5f58b5da81a2fe6c0cdf8\", \"0227f452ec09b0d887307682ed8db0655a57457771594bf654bb521cc8990f7bee\", \"03a31cf9099bc1be843afb97d28376824fea7788712976add883abfe9aceffcb82\"]"`
- Ensure that the output is `9rUZv4sr7pgqhmw7Q9XLDb42w9EcUkUZCc`. This will be the CHANGE_ADDRESS where all holdings are collated at every payout.
- Run `dingocoin-cli importaddress "REDEEM_SCRIPT" "" true` where REDEEM_SCRIPT is from running `dingocoin-cli create multisig...`.

#### 2. Add BSC private key.
- In `settings/private.DO_NOT_SHARE_THIS.json`, replace `0xExampleWhichYouShouldReplace` with your BSC_WALLET_PRIVATE_KEY. Ensure that the double quotes remain around your private key.
- DO NOT REVEAL THIS AT ALL COSTS.

#### 3. Create your database to record payouts history.
- Install `sqlite3`: `sudo apt install sqlite3`
- Go to the `wdingocoin/settings/database` folder: `cd wdingocoin/settings/database`
- Create the database file and enter sqlite3 console: `sqlite3 wDingo.db`
- Run the initialization script: `.read schema_authority.sql`
- Once done, you can simply exit the console via `Ctrl+X` or `Ctrl+D`.

#### 4. Setup SSL.
- Setup SSL related software:
    - `sudo apt install snap`
    - `sudo snap install --classic certbot`
    - `sudo ln -s /snap/bin/certbot /usr/bin/certbot`
- Generate certs: `sudo certbot certonly --standalone --register-unsafely-without-email`
    - You may be asked to accept terms of service. Press Y to agree.
    - You will be asked to enter the domain name for the certificate. Enter yours correspondingly based on your node index: `n0.dingocoin.org`, `n1.dingocoin.org`, ..., `n4.dingocoin.org`.
    - This step may fail if port 80 and 443 is blocked. Please temporarily allow access to these ports.
- Upon success, you will see a message saying something like:
    ```
    ...
    Certificate is saved at: /etc/letsencrypt/live/n4.dingocoin.org/fullchain.pem
    Key is saved at:         /etc/letsencrypt/live/n4.dingocoin.org/privkey.pem
    ...
    ```
    Note down these two paths (we will refer to them as CERTIFICATE_PATH and KEY_PATH respectively).
- Set certbot data dir permissions: 
    - `sudo groupadd ssl-cert`
    - `echo $USER | xargs -I{} sudo usermod -a -G ssl-cert {}`
    - `sudo chgrp -R ssl-cert /etc/letsencrypt`
    - `sudo chmod -R g=rX /etc/letsencrypt`
    - Re-login.
- Add CERTIFICATE_PATH and KEY_PATH to wdingocoin settings:
    - Open `wdingocoin/settings/ssl.json`
    - Set value of `certPath` and `key_path` to CERTIFICATE_PATH and KEY_PATH respectively.
    - e.g. `ssl.json`:
        ```
        {
          "certPath": "/etc/letsencrypt/live/n4.dingocoin.org/fullchain.pem",
          "keyPath": /etc/letsencrypt/live/n4.dingocoin.org/privkey.pem"
        }
        ```

#### 5. Install nodejs and yarn, and setup project dependencies.
- `sudo apt install nodejs npm`
- `sudo npm install -g yarn`
- `cd wdingocoin`; `yarn install`

#### 6. Ensure that port 32533 is open. Use https://www.yougetsignal.com/tools/open-ports/ to check that port 32533 on your node can be reached with the authority daemon running. If not, check your firewall/VPS provider/ISP settings to make sure that port 32533 is not blocked.

#### 7. Launch dingo daemon and authority daemon.
- `dingod`
- `cd wdingocoin`; `nodejs authorityDaemon.js` (If `nodejs authorityDaemon.js` does not work, try `node authorityDaemon.js`).
- You can run these daemons in a `tmux`. This allows you to leave the SSH session while still running and recording stdout/stderr debug messages in the background.

#### 8. Users access the system via the [web application](https://wdingocoin.github.io/wdingocoin-frontend/), whose source code can be found [here](https://github.com/wdingocoin/wdingocoin-frontend). The web application interacts directly with the authority nodes. Alternatively you use the CLI (`nodejs cli.js`; `help`) to interact with the authority nodes.

# Optional Steps:

#### Verifying shared credentials
- In `wdingocoin/settings/public.json`, check that the IP locations and BSC wallet addresses of every node match the collected list.
- In `wdingocoin/settings/dingo.json`, check that the change address matches the one computed in step 1 (`9rUZv4sr7pgqhmw7Q9XLDb42w9EcUkUZCc`), and that the tax payour addresses match the collected list.
- In `wdingocoin/settings/smartContract.js`, check that the contractAddress is what has just been published, `0x9b208b117B2C4F76C1534B6f006b033220a681A4`.

#### Verifying smart contract
- You can explore the BSC Smart Contract here: `https://bscscan.com/token/0x9b208b117B2C4F76C1534B6f006b033220a681A4`. For the folks who are new to this, this is basically like blockexplorer but you see all interactions with the smart contract.
- The Smart Contract source code has been uploaded and verified here: `https://bscscan.com/address/0x9b208b117B2C4F76C1534B6f006b033220a681A4#code`.
- Verify that the `_authorityAddresses` (Line 122) has been set to the BSC wallet addresses in the collected list.
- If you are up for it, you can read through the smartContract to verify the multisignature design.
