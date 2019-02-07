/**
 * Copyright 2018-present Facebook.
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * @format
 */

import LogManager from '../fb-stubs/Logger';
import {RecurringError} from './errors';
import {promisify} from 'util';
const fs = require('fs');
const adb = require('adbkit-fb');
import {
  openssl,
  isInstalled as opensslInstalled,
} from './openssl-wrapper-with-promises';
const path = require('path');
const tmp = require('tmp');
const tmpFile = promisify(tmp.file);
const tmpDir = promisify(tmp.dir);
import iosUtil from '../fb-stubs/iOSContainerUtility';
import {reportPlatformFailures} from './metrics';

// Desktop file paths
const os = require('os');
const caKey = getFilePath('ca.key');
const caCert = getFilePath('ca.crt');
const serverKey = getFilePath('server.key');
const serverCsr = getFilePath('server.csr');
const serverCert = getFilePath('server.crt');

// Device file paths
const csrFileName = 'app.csr';
const deviceCAcertFile = 'sonarCA.crt';
const deviceClientCertFile = 'device.crt';

const caSubject = '/C=US/ST=CA/L=Menlo Park/O=Sonar/CN=SonarCA';
const serverSubject = '/C=US/ST=CA/L=Menlo Park/O=Sonar/CN=localhost';
const minCertExpiryWindowSeconds = 24 * 60 * 60;
const appNotDebuggableRegex = /debuggable/;
const allowedAppNameRegex = /^[a-zA-Z0-9._\-]+$/;
const operationNotPermittedRegex = /not permitted/;
const logTag = 'CertificateProvider';
/*
 * RFC2253 specifies the unamiguous x509 subject format.
 * However, even when specifying this, different openssl implementations
 * wrap it differently, e.g "subject=X" vs "subject= X".
 */
const x509SubjectCNRegex = /[=,]\s*CN=([^,]*)(,.*)?$/;

export type SecureServerConfig = {|
  key: Buffer,
  cert: Buffer,
  ca: Buffer,
  requestCert: boolean,
  rejectUnauthorized: boolean,
|};

/*
 * This class is responsible for generating and deploying server and client
 * certificates to allow for secure communication between Flipper and apps.
 * It takes a Certificate Signing Request which was generated by the app,
 * using the app's public/private keypair.
 * With this CSR it uses the Flipper CA to sign a client certificate which it
 * deploys securely to the app.
 * It also deploys the Flipper CA cert to the app.
 * The app can trust a server if and only if it has a certificate signed by the
 * Flipper CA.
*/
export default class CertificateProvider {
  logger: LogManager;
  adb: any;
  certificateSetup: Promise<void>;
  server: Server;

  constructor(server: Server, logger: LogManager) {
    this.logger = logger;
    this.adb = adb.createClient({
      port: process.env.ANDROID_ADB_SERVER_PORT || '5037',
    });
    this.certificateSetup = reportPlatformFailures(
      this.ensureServerCertExists(),
      'ensureServerCertExists',
    );
    this.server = server;
  }

  processCertificateSigningRequest(
    unsanitizedCsr: string,
    os: string,
    appDirectory: string,
  ): Promise<{|deviceId: string|}> {
    const csr = this.santitizeString(unsanitizedCsr);
    if (csr === '') {
      return Promise.reject(new Error(`Received empty CSR from ${os} device`));
    }
    this.ensureOpenSSLIsAvailable();
    return this.certificateSetup
      .then(_ => this.getCACertificate())
      .then(caCert =>
        this.deployFileToMobileApp(
          appDirectory,
          deviceCAcertFile,
          caCert,
          csr,
          os,
        ),
      )
      .then(_ => this.generateClientCertificate(csr))
      .then(clientCert =>
        this.deployFileToMobileApp(
          appDirectory,
          deviceClientCertFile,
          clientCert,
          csr,
          os,
        ),
      )
      .then(_ => this.extractAppNameFromCSR(csr))
      .then(appName => this.getTargetDeviceId(os, appName, appDirectory, csr))
      .then(deviceId => {
        return {
          deviceId,
        };
      });
  }

  getTargetDeviceId(
    os: string,
    appName: string,
    appDirectory: string,
    csr: string,
  ): Promise<string> {
    if (os === 'Android') {
      return this.getTargetAndroidDeviceId(appName, appDirectory, csr);
    } else if (os === 'iOS') {
      return this.getTargetiOSDeviceId(appName, appDirectory, csr);
    }
    return Promise.resolve('unknown');
  }

  ensureOpenSSLIsAvailable(): void {
    if (!opensslInstalled()) {
      const e = Error(
        "It looks like you don't have OpenSSL installed. Please install it to continue.",
      );
      this.server.emit('error', e);
    }
  }

  getCACertificate(): Promise<string> {
    return new Promise((resolve, reject) => {
      fs.readFile(caCert, (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data.toString());
        }
      });
    });
  }

  generateClientCertificate(csr: string): Promise<string> {
    console.debug('Creating new client cert', logTag);

    return this.writeToTempFile(csr).then(path => {
      return openssl('x509', {
        req: true,
        in: path,
        CA: caCert,
        CAkey: caKey,
        CAcreateserial: true,
      });
    });
  }

  getRelativePathInAppContainer(absolutePath: string) {
    const matches = /Application\/[^/]+\/(.*)/.exec(absolutePath);
    if (matches && matches.length === 2) {
      return matches[1];
    }
    throw new Error("Path didn't match expected pattern: " + absolutePath);
  }

  deployFileToMobileApp(
    destination: string,
    filename: string,
    contents: string,
    csr: string,
    os: string,
  ): Promise<void> {
    const appNamePromise = this.extractAppNameFromCSR(csr);

    if (os === 'Android') {
      const deviceIdPromise = appNamePromise.then(app =>
        this.getTargetAndroidDeviceId(app, destination, csr),
      );
      return Promise.all([deviceIdPromise, appNamePromise]).then(
        ([deviceId, appName]) =>
          this.pushFileToAndroidDevice(
            deviceId,
            appName,
            destination + filename,
            contents,
          ),
      );
    }
    if (os === 'iOS' || os === 'windows') {
      return promisify(fs.writeFile)(destination + filename, contents).catch(
        err => {
          if (os === 'iOS') {
            // Writing directly to FS failed. It's probably a physical device.
            const relativePathInsideApp = this.getRelativePathInAppContainer(
              destination,
            );
            return appNamePromise
              .then(appName =>
                this.getTargetiOSDeviceId(appName, destination, csr),
              )
              .then(udid => {
                return appNamePromise.then(appName =>
                  this.pushFileToiOSDevice(
                    udid,
                    appName,
                    relativePathInsideApp,
                    filename,
                    contents,
                  ),
                );
              });
          }
          throw new Error(
            `Invalid appDirectory recieved from ${os} device: ${destination}: ` +
              err.toString(),
          );
        },
      );
    }
    return Promise.reject(new RecurringError(`Unsupported device os: ${os}`));
  }

  pushFileToiOSDevice(
    udid: string,
    bundleId: string,
    destination: string,
    filename: string,
    contents: string,
  ): Promise<void> {
    return tmpDir({unsafeCleanup: true}).then(dir => {
      const filePath = path.resolve(dir, filename);
      promisify(fs.writeFile)(filePath, contents).then(() =>
        iosUtil.push(udid, filePath, bundleId, destination),
      );
    });
  }

  getTargetAndroidDeviceId(
    appName: string,
    deviceCsrFilePath: string,
    csr: string,
  ): Promise<string> {
    return this.adb.listDevices().then((devices: Array<{id: string}>) => {
      const deviceMatchList = devices.map(device =>
        this.androidDeviceHasMatchingCSR(
          deviceCsrFilePath,
          device.id,
          appName,
          csr,
        )
          .then(isMatch => {
            return {id: device.id, isMatch};
          })
          .catch(e => {
            console.error(
              `Unable to check for matching CSR in ${device.id}:${appName}`,
              logTag,
            );
            return {id: device.id, isMatch: false};
          }),
      );
      return Promise.all(deviceMatchList).then(devices => {
        const matchingIds = devices.filter(m => m.isMatch).map(m => m.id);
        if (matchingIds.length == 0) {
          throw new RecurringError(
            `No matching device found for app: ${appName}`,
          );
        }
        if (matchingIds.length > 1) {
          console.error(
            new RecurringError('More than one matching device found for CSR'),
            csr,
          );
        }
        return matchingIds[0];
      });
    });
  }

  getTargetiOSDeviceId(
    appName: string,
    deviceCsrFilePath: string,
    csr: string,
  ): Promise<string> {
    const matches = /\/Devices\/([^/]+)\//.exec(deviceCsrFilePath);
    if (matches && matches.length == 2) {
      // It's a simulator, the deviceId is in the filepath.
      return Promise.resolve(matches[1]);
    }
    return iosUtil.targets().then(targets => {
      const deviceMatchList = targets.map(target =>
        this.iOSDeviceHasMatchingCSR(
          deviceCsrFilePath,
          target.udid,
          appName,
          csr,
        ).then(isMatch => {
          return {id: target.udid, isMatch};
        }),
      );
      return Promise.all(deviceMatchList).then(devices => {
        const matchingIds = devices.filter(m => m.isMatch).map(m => m.id);
        if (matchingIds.length == 0) {
          throw new RecurringError(
            `No matching device found for app: ${appName}`,
          );
        }
        return matchingIds[0];
      });
    });
  }

  androidDeviceHasMatchingCSR(
    directory: string,
    deviceId: string,
    processName: string,
    csr: string,
  ): Promise<boolean> {
    return this.executeCommandOnAndroid(
      deviceId,
      processName,
      `cat ${directory + csrFileName}`,
    )
      .then(deviceCsr => {
        return this.santitizeString(deviceCsr.toString()) === csr;
      })
      .catch(err => {
        console.error(err, logTag);
        return false;
      });
  }

  iOSDeviceHasMatchingCSR(
    directory: string,
    deviceId: string,
    bundleId: string,
    csr: string,
  ): Promise<boolean> {
    const originalFile = this.getRelativePathInAppContainer(
      path.resolve(directory, csrFileName),
    );
    return tmpDir({unsafeCleanup: true})
      .then(dir => {
        return iosUtil
          .pull(deviceId, originalFile, bundleId, dir)
          .then(() => dir);
      })
      .then(dir => {
        return promisify(fs.readdir)(dir)
          .then(items => {
            if (items.length !== 1) {
              throw new Error('Conflict in temp dir');
            }
            return items[0];
          })
          .then(fileName => {
            const copiedFile = path.resolve(dir, fileName);
            return promisify(fs.readFile)(copiedFile).then(data =>
              this.santitizeString(data.toString()),
            );
          });
      })
      .then(csrFromDevice => csrFromDevice === csr);
  }

  santitizeString(csrString: string): string {
    return csrString.replace(/\r/g, '').trim();
  }

  pushFileToAndroidDevice(
    deviceId: string,
    app: string,
    filename: string,
    contents: string,
  ): Promise<void> {
    console.debug(`Deploying ${filename} to ${deviceId}:${app}`, logTag);
    return this.executeCommandOnAndroid(
      deviceId,
      app,
      `echo "${contents}" > ${filename} && chmod 600 ${filename}`,
    ).then(output => undefined);
  }

  executeCommandOnAndroid(
    deviceId: string,
    user: string,
    command: string,
  ): Promise<string> {
    if (!user.match(allowedAppNameRegex)) {
      return Promise.reject(
        new RecurringError(`Disallowed run-as user: ${user}`),
      );
    }
    if (command.match(/[']/)) {
      return Promise.reject(
        new RecurringError(`Disallowed escaping command: ${command}`),
      );
    }
    return this.adb
      .shell(deviceId, `echo '${command}' | run-as '${user}'`)
      .then(adb.util.readAll)
      .then(buffer => buffer.toString())
      .then(output => {
        if (output.match(appNotDebuggableRegex)) {
          const e = new RecurringError(
            `Android app ${user} is not debuggable. To use it with Flipper, add android:debuggable="true" to the application section of AndroidManifest.xml`,
          );
          this.server.emit('error', e);
          throw e;
        }
        if (output.toLowerCase().match(operationNotPermittedRegex)) {
          const e = new RecurringError(
            `Your android device (${deviceId}) does not support the adb shell run-as command. We're tracking this at https://github.com/facebook/flipper/issues/92`,
          );
          this.server.emit('error', e);
          throw e;
        }
        return output;
      });
  }

  extractAppNameFromCSR(csr: string): Promise<string> {
    return this.writeToTempFile(csr)
      .then(path =>
        openssl('req', {
          in: path,
          noout: true,
          subject: true,
          nameopt: true,
          RFC2253: false,
        }).then(subject => {
          return [path, subject];
        }),
      )
      .then(([path, subject]) => {
        return new Promise(function(resolve, reject) {
          fs.unlink(path, err => {
            if (err) {
              reject(err);
            } else {
              resolve(subject);
            }
          });
        });
      })
      .then(subject => {
        const matches = subject.trim().match(x509SubjectCNRegex);
        if (!matches || matches.length < 2) {
          throw new RecurringError(`Cannot extract CN from ${subject}`);
        }
        return matches[1];
      })
      .then(appName => {
        if (!appName.match(allowedAppNameRegex)) {
          throw new RecurringError(
            `Disallowed app name in CSR: ${appName}. Only alphanumeric characters and '.' allowed.`,
          );
        }
        return appName;
      });
  }

  loadSecureServerConfig(): Promise<SecureServerConfig> {
    return this.certificateSetup.then(() => {
      return {
        key: fs.readFileSync(serverKey),
        cert: fs.readFileSync(serverCert),
        ca: fs.readFileSync(caCert),
        requestCert: true,
        rejectUnauthorized: true, // can be false if necessary as we don't strictly need to verify the client
      };
    });
  }

  ensureCertificateAuthorityExists(): Promise<void> {
    if (!fs.existsSync(caKey)) {
      return this.generateCertificateAuthority();
    }
    return this.checkCertIsValid(caCert).catch(e =>
      this.generateCertificateAuthority(),
    );
  }

  checkCertIsValid(filename: string): Promise<void> {
    if (!fs.existsSync(filename)) {
      return Promise.reject();
    }
    // openssl checkend is a nice feature but it only checks for certificates
    // expiring in the future, not those that have already expired.
    // So we need a separate check for certificates that have already expired
    // but since this involves parsing date outputs from openssl, which is less
    // reliable, keeping both checks for safety.
    return openssl('x509', {
      checkend: minCertExpiryWindowSeconds,
      in: filename,
    })
      .then(output => undefined)
      .catch(e => {
        console.warn(`Certificate will expire soon: ${filename}`, logTag);
        throw e;
      })
      .then(_ =>
        openssl('x509', {
          enddate: true,
          in: filename,
          noout: true,
        }),
      )
      .then(endDateOutput => {
        const dateString = endDateOutput
          .trim()
          .split('=')[1]
          .trim();
        const expiryDate = Date.parse(dateString);
        if (isNaN(expiryDate)) {
          console.error(
            'Unable to parse certificate expiry date: ' + endDateOutput,
          );
          throw new Error(
            'Cannot parse certificate expiry date. Assuming it has expired.',
          );
        }
        if (expiryDate <= Date.now() + minCertExpiryWindowSeconds * 1000) {
          throw new Error('Certificate has expired or will expire soon.');
        }
      });
  }

  verifyServerCertWasIssuedByCA() {
    const options = {CAfile: caCert};
    options[serverCert] = false;
    return openssl('verify', options).then(output => {
      const verified = output.match(/[^:]+: OK/);
      if (!verified) {
        // This should never happen, but if it does, we need to notice so we can
        // generate a valid one, or no clients will trust our server.
        throw new Error('Current server cert was not issued by current CA');
      }
    });
  }

  generateCertificateAuthority(): Promise<void> {
    if (!fs.existsSync(getFilePath(''))) {
      fs.mkdirSync(getFilePath(''));
    }
    console.log('Generating new CA', logTag);
    return openssl('genrsa', {out: caKey, '2048': false})
      .then(_ =>
        openssl('req', {
          new: true,
          x509: true,
          subj: caSubject,
          key: caKey,
          out: caCert,
        }),
      )
      .then(_ => undefined);
  }

  ensureServerCertExists(): Promise<void> {
    if (
      !(
        fs.existsSync(serverKey) &&
        fs.existsSync(serverCert) &&
        fs.existsSync(caCert)
      )
    ) {
      return this.generateServerCertificate();
    }

    return this.checkCertIsValid(serverCert)
      .then(_ => this.verifyServerCertWasIssuedByCA())
      .catch(e => this.generateServerCertificate());
  }

  generateServerCertificate(): Promise<void> {
    return this.ensureCertificateAuthorityExists()
      .then(_ => {
        console.warn('Creating new server cert', logTag);
      })
      .then(_ => openssl('genrsa', {out: serverKey, '2048': false}))
      .then(_ =>
        openssl('req', {
          new: true,
          key: serverKey,
          out: serverCsr,
          subj: serverSubject,
        }),
      )
      .then(_ =>
        openssl('x509', {
          req: true,
          in: serverCsr,
          CA: caCert,
          CAkey: caKey,
          CAcreateserial: true,
          out: serverCert,
        }),
      )
      .then(_ => undefined);
  }

  writeToTempFile(content: string): Promise<string> {
    return tmpFile().then((path, fd, cleanupCallback) =>
      promisify(fs.writeFile)(path, content).then(_ => path),
    );
  }
}

function getFilePath(fileName: string): string {
  return path.resolve(os.homedir(), '.flipper', 'certs', fileName);
}
