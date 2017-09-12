
# oajax.js

oajax.js is offline based http/https request handler which can handle the http request whether server is offline or online .when server is not available or offline its maintain state of request using local data storage of browser and when server is online its automatically sync the locally maintained request states with server . oajax also give support of get or post data when server is not available so that's why it is very useful tool for js based mobile application development platform like Phonegap (cordova) where local data handling is big challenge 

Download [oajax.min.js](https://raw.githubusercontent.com/chasgharali/oajax.js/master/dist/oajax.min.js) 

or use [Bower](http://bower.io/) to install:

```bash
$ bower install oajax.js --save
```



## Usage
**This library use instead of ajax request in otherword its offline ajax request handler so you can easily replace your ajax request with oajax to make your app works offline perfectly.**

### basic http request method 

```javascript
	
    var Type = "POST"; 
    var URL = "http://localhost/getdata.php"; 
    var ContentType = "application/json; charset=utf-8"; // leave it empty string if you don't use any contentType
    var Data = [{
                	"column" : "id",
                   "value" : "2"
                  }]; //Main Payload

			/////sending oajax request////
      oajax.request(Type ,URL ,Data ,ContentType ,
      	function(data){ // callback function on success or error
                    $("#data").val( JSON.stringify(data));
                });
```


**Keywords**

javascript, js, jquery, node.js, oajax, offline http request, offline database, realm, local webstorage, sqllite, phonegap, cordova,local database , oajax.js , ojax, ojax.js


