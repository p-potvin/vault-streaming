const fs = require('fs');
const crypto = require('crypto');

function registerCryptoHandlers(ipcMain) {
    ipcMain.handle('encrypt-files', async (event, { paths, password }) => {
        console.log(`[main:crypto] Encrypting ${paths.length} files`);
        try {
            for (const filePath of paths) {
                if (!fs.existsSync(filePath)) continue;
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) continue;

                const fileData = fs.readFileSync(filePath);
                const salt = crypto.randomBytes(16);
                const key = crypto.scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 });
                const iv = crypto.randomBytes(16);

                const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
                const encrypted = Buffer.concat([cipher.update(fileData), cipher.final()]);

                const outputData = Buffer.concat([salt, iv, encrypted]);
                const outputEncPath = filePath + '.enc';

                fs.writeFileSync(outputEncPath, outputData);
                fs.unlinkSync(filePath);
            }
            return { success: true };
        } catch (e) {
            console.error(`[main:crypto] Encryption failed: ${e.message}`);
            return { success: false, error: e.message };
        }
    });

    ipcMain.handle('decrypt-files', async (event, { paths, password }) => {
        console.log(`[main:crypto] Decrypting ${paths.length} files`);
        try {
            let successCount = 0;
            for (const filePath of paths) {
                if (!fs.existsSync(filePath) || !filePath.endsWith('.enc')) continue;

                const fileData = fs.readFileSync(filePath);
                if (fileData.length < 32) continue;

                const salt = fileData.subarray(0, 16);
                const iv = fileData.subarray(16, 32);
                const encryptedData = fileData.subarray(32);

                const key = crypto.scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 });
                const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

                let decrypted;
                try {
                    decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
                } catch (err) {
                    continue;
                }

                const outputDecPath = filePath.substring(0, filePath.length - 4);
                fs.writeFileSync(outputDecPath, decrypted);
                fs.unlinkSync(filePath);
                successCount++;
            }
            return { success: successCount === paths.length, count: successCount };
        } catch (e) {
            console.error(`[main:crypto] Decryption failed: ${e.message}`);
            return { success: false, error: e.message };
        }
    });
}

module.exports = { registerCryptoHandlers };
