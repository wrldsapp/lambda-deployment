
const AWS = require("aws-sdk");
const lambda = new AWS.Lambda({ apiVersion: "2015-03-31" });
var iam = new AWS.IAM({ apiVersion: "2010-05-08" });
const core = require('@actions/core');
const archiver = require("archiver");
const promiseRetry = require("promise-retry");
const fs = require('fs');
const style = require('ansi-styles');


async function deployFunction(params) {
  return new Promise(async function(resolve, reject) {
    let options = {
      retries: 4,
      factor: 1,
      minTimeout: 6500,
      maxTimeout: 15000
    };
    promiseRetry(options, function(retry, number) {
      return uploadPackage(params)
      .catch(err => {
        if (err.code === "InvalidParameterValueException") {
          retry(err);
        }
        reject(err);
      });
    })
    .then(data => {
      let newFunction = {name: data.FunctionName, arn: data.FunctionArn};
      resolve(newFunction);
    });
  });
}


function uploadPackage(params) {
  return new Promise(function (resolve, reject) {
    lambda.createFunction(params, function(err, data) {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
} 


async function zipPackage(name) {
  let workspace = process.env.GITHUB_WORKSPACE;
  const source = `${workspace}/REST/${name}`;
  const dest = `${source}/${name}.zip`;
  const archive = archiver("zip", { zlib: { level: 9 } });
  const stream = fs.createWriteStream(dest);

  return new Promise(async (resolve, reject) => {
    archive
      .directory(source, false)
      .on("error", (err) => reject(err))
      .pipe(stream);
    stream.on("close", () => resolve(dest));
    archive.finalize();
  });
}


async function createExecutionRole(name) {
  return new Promise(async function(resolve, reject) {
    let arn = await createRole(name);
    await attachPolicy(name);
    resolve(arn);
  });
}


// Creates the execution role for the Lambda function.
// Each function must have its own execution role.
const createRole = async (name) => {
  return new Promise(function (resolve, reject) {
    var policy = require("../policies/default.json");
    var createParams = {
      AssumeRolePolicyDocument: JSON.stringify(policy),
      RoleName: `${name}-ExecRole`,
    };

    iam.createRole(createParams, function (err, data) {
      if (err) {
        reject(err);
      } else {
        resolve(data.Role.Arn);
      }
    });
  });
};

// Attaches the default IAM policy to the Lambda
// function's role.
const attachPolicy = async (name) => {
  return new Promise(function (resolve, reject) {
    var policyParams = {
      PolicyArn:
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      RoleName: `${name}-ExecRole`,
    };

    iam.attachRolePolicy(policyParams, function (err, data) {
      if (err) {
        console.log(err, err.stack);
      } else {
        resolve();
      }
    });
  });
};


const create = async (created) => {
  return await Promise.all(created.map(async (x) => {
    return new Promise(async function(resolve, reject) {
      let packagePath = await zipPackage(x);
      let roleArn = await createExecutionRole(x);
        let params = {
          Code: {ZipFile: fs.readFileSync(packagePath)},
          FunctionName: x,
          Handler: "index.js",
          Role: roleArn,
          Runtime: "nodejs12.x"
        };
      let newFunction = await deployFunction(params);
      console.log(`${style.green.open}Successfully deployed Lambda '${newFunction.name}' with arn: ${newFunction.arn}${style.green.close}`);
      resolve(newFunction);
    });
  }));
};


const update = async (updates) => {
    return new Promise(async function (resolve, reject) {
      for (i in updates) {
        let packagePath = await zipPackage(updates[i]);
        var params = {
          FunctionName: updates[i],
          Publish: false,
          ZipFile: fs.readFileSync(packagePath) /* Strings will be Base-64 encoded on your behalf */
        };
        lambda.updateFunctionCode(params,
          function(err, data) {
            if (err) {
              console.log(`Error updating function: ${updates[i]}`);
            }
            if (data) {
              console.log('Successfully updated function:', data.FunctionName);
            }
        });
      }
      resolve();
    });
  };



const remove = async (deleted) => {
    return new Promise(async function (resolve, reject) {
      for (i in deleted) {
        var params = {
          FunctionName: deleted[i],
        };
        lambda.deleteFunction(params, function (err, data) {
          if (err) {
            reject(err);
          }
        });
      }
      resolve(deleted);
    });
};


try {
  let updates = JSON.parse(core.getInput("updates"));
  Promise.allSettled([
    create(updates.created),
    remove(updates.deleted),
    update(updates.updated),
  ]).then((values) => {
    let output = {
      created: values[0].value,
      deleted: values[1].value,
    };
    core.setOutput("functions", output);
  });
} catch (err) {
  core.setFailed(err);
}
  
